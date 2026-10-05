//! Part planning: how a transfer of `size` bytes is split for a given `partSizeMib` setting.
//! Pure functions, so every combination is unit-tested without a server.

use super::MIB;

/// Auto part size up to 1 GiB, and above it.
pub const AUTO_PART_SIZE: u64 = 8 * MIB;
pub const AUTO_PART_SIZE_LARGE: u64 = 16 * MIB;
/// Objects above this use [`AUTO_PART_SIZE_LARGE`] in Auto mode (downloads).
pub const AUTO_LARGE_OBJECT: u64 = 1024 * MIB;
/// S3 minimum size of every non-final multipart upload part.
pub const MIN_UPLOAD_PART_SIZE: u64 = 5 * MIB;
/// S3 maximum number of parts in a multipart upload.
pub const MAX_UPLOAD_PARTS: u64 = 10_000;

/// How one transfer is split. `multipart == false` means a single GET / PutObject (`parts == 1`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PartPlan {
    pub part_size: u64,
    pub parts: u64,
    pub multipart: bool,
}

impl PartPlan {
    fn for_size(size: u64, part_size: u64) -> Self {
        if size > part_size {
            Self { part_size, parts: size.div_ceil(part_size), multipart: true }
        } else {
            Self { part_size, parts: 1, multipart: false }
        }
    }

    /// `parts` as reported in `Transfer.partsTotal`.
    pub fn parts_total(&self) -> u32 {
        u32::try_from(self.parts).unwrap_or(u32::MAX)
    }
}

/// Download part size: the setting, or Auto (8 MiB; 16 MiB for objects over 1 GiB).
pub fn download_part_size(size: u64, part_size_mib: Option<u32>) -> u64 {
    match part_size_mib {
        Some(mib) => u64::from(mib.max(1)) * MIB,
        None if size > AUTO_LARGE_OBJECT => AUTO_PART_SIZE_LARGE,
        None => AUTO_PART_SIZE,
    }
}

/// Split when `size > part size`, into `ceil(size / part size)` ranged GETs.
pub fn plan_download(size: u64, part_size_mib: Option<u32>) -> PartPlan {
    PartPlan::for_size(size, download_part_size(size, part_size_mib))
}

/// Upload part size: `max(setting, 5 MiB)` (Auto: 8 MiB), doubled until the file fits in 10,000
/// parts. Auto reproduces the pre-settings behavior exactly.
pub fn upload_part_size(size: u64, part_size_mib: Option<u32>) -> u64 {
    let mut ps = match part_size_mib {
        Some(mib) => (u64::from(mib) * MIB).max(MIN_UPLOAD_PART_SIZE),
        None => AUTO_PART_SIZE,
    };
    while size.div_ceil(ps) > MAX_UPLOAD_PARTS {
        ps *= 2;
    }
    ps
}

/// Multipart when the file is larger than the effective part size; otherwise one PutObject.
pub fn plan_upload(size: u64, part_size_mib: Option<u32>) -> PartPlan {
    PartPlan::for_size(size, upload_part_size(size, part_size_mib))
}

#[cfg(test)]
mod tests {
    use super::*;

    const GIB: u64 = 1024 * MIB;

    #[test]
    fn download_auto_matches_previous_behavior() {
        // Old rule: single GET when size <= 8 MiB, else 8 MiB parts (16 MiB above 1 GiB).
        assert_eq!(plan_download(0, None), PartPlan { part_size: 8 * MIB, parts: 1, multipart: false });
        assert!(!plan_download(8 * MIB, None).multipart);
        assert_eq!(plan_download(8 * MIB + 1, None), PartPlan { part_size: 8 * MIB, parts: 2, multipart: true });
        assert_eq!(plan_download(100 * MIB, None).parts, 13);
        assert_eq!(plan_download(GIB, None), PartPlan { part_size: 8 * MIB, parts: 128, multipart: true });
        assert_eq!(plan_download(GIB + 1, None), PartPlan { part_size: 16 * MIB, parts: 65, multipart: true });
    }

    #[test]
    fn download_with_settings() {
        let size = 100 * MIB;
        assert_eq!(plan_download(size, Some(1)), PartPlan { part_size: MIB, parts: 100, multipart: true });
        assert_eq!(plan_download(size, Some(8)), PartPlan { part_size: 8 * MIB, parts: 13, multipart: true });
        assert_eq!(plan_download(size, Some(64)), PartPlan { part_size: 64 * MIB, parts: 2, multipart: true });
        assert!(!plan_download(size, Some(128)).multipart);
        assert!(!plan_download(size, Some(100)).multipart, "size == part size is a single GET");
        assert_eq!(plan_download(40 * MIB, Some(4)).parts, 10);
        assert_eq!(plan_download(40 * MIB, Some(64)).parts_total(), 1);
        // Settings apply above 1 GiB too (no Auto doubling).
        assert_eq!(plan_download(2 * GIB, Some(4)).parts, 512);
        // A 1 MiB object with 1 MiB parts: single GET.
        assert_eq!(plan_download(MIB, Some(1)).parts, 1);
    }

    #[test]
    fn upload_auto_matches_previous_behavior() {
        assert_eq!(upload_part_size(40 * MIB, None), 8 * MIB);
        assert_eq!(upload_part_size(80_000 * MIB, None), 8 * MIB);
        assert_eq!(upload_part_size(80_001 * MIB, None), 16 * MIB);
        assert!(!plan_upload(8 * MIB, None).multipart);
        assert_eq!(plan_upload(8 * MIB + 1, None).parts, 2);
        assert_eq!(plan_upload(40 * MIB, None).parts, 5);
        let five_tb = 5 * 1024 * GIB;
        assert!(five_tb.div_ceil(upload_part_size(five_tb, None)) <= MAX_UPLOAD_PARTS);
    }

    #[test]
    fn upload_with_settings() {
        // Below the S3 minimum: 5 MiB parts.
        assert_eq!(plan_upload(40 * MIB, Some(1)), PartPlan { part_size: 5 * MIB, parts: 8, multipart: true });
        assert_eq!(plan_upload(40 * MIB, Some(4)).part_size, 5 * MIB);
        assert!(!plan_upload(5 * MIB, Some(1)).multipart);
        assert_eq!(plan_upload(5 * MIB + 1, Some(1)).parts, 2);
        assert_eq!(plan_upload(100 * MIB, Some(8)).parts, 13);
        assert_eq!(plan_upload(100 * MIB, Some(64)).parts, 2);
        assert!(!plan_upload(100 * MIB, Some(256)).multipart);
        // 60,000 MiB at 5 MiB would be 12,000 parts: grows to 10 MiB (6,000 parts).
        let p = plan_upload(60_000 * MIB, Some(5));
        assert_eq!((p.part_size, p.parts), (10 * MIB, 6_000));
        // Exactly 10,000 parts is allowed.
        assert_eq!(plan_upload(50_000 * MIB, Some(5)).parts, 10_000);
        let five_tb = 5 * 1024 * GIB;
        for mib in [1, 5, 7, 64, 256] {
            let p = plan_upload(five_tb, Some(mib));
            assert!(p.parts <= MAX_UPLOAD_PARTS && p.part_size >= MIN_UPLOAD_PART_SIZE, "{mib}: {p:?}");
        }
    }
}
