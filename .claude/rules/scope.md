# Product scope (v1)

The user defined v1 precisely. Deliver exactly this, do not widen it:

1. Connect with an AWS profile or static credentials (optional custom endpoint for MinIO/R2).
2. List buckets.
3. Browse objects and folders with basic metadata (size, last modified, storage class, etag).
4. Upload objects (multipart for large files).
5. Download objects (parallel ranged parts).
6. Create folders and delete folders (recursive).

Explicitly **not** in v1: deleting or renaming single objects, copying/moving, bucket
creation/deletion, versioning UI, presigned URLs, permissions/ACL editing, sync.
If a task seems to need one of these, stop and ask the user instead of adding it.
