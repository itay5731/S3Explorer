---
name: contract-check
description: Check that the Rust backend and the TypeScript frontend still match docs/CONTRACT.md (command names, camelCase serde, event name, types). Use after either side changes bridge code.
---

# Contract check

Everything crossing the Tauri bridge must agree with `docs/CONTRACT.md`. Run these greps and
compare; fix mismatches on the side that drifted, or update the contract first if the change is intended.

1. **Command names registered vs. invoked**
   ```bash
   grep -ho 'generate_handler!\[[^]]*\]' -r src-tauri/src | tr ',' '\n' | grep -o '[a-z_:]*[a-z_]' | sed 's/.*:://' | sort -u
   grep -ho 'invoke[<(][^"]*"[a-z_]*"' -r src/lib/api.ts | grep -o '"[a-z_]*"' | tr -d '"' | sort -u
   ```
   The two lists must be identical and equal to the command table in the contract.
2. **Every bridge struct is camelCase**
   ```bash
   grep -rn 'derive(.*Serialize' src-tauri/src | grep -v 'rename_all = "camelCase"' -A0
   grep -rn -B1 'rename_all = "camelCase"' src-tauri/src | grep -c derive
   ```
   Any `Serialize`/`Deserialize` type without `rename_all = "camelCase"` on the next line is a bug
   (the second grep is a sanity count).
3. **Event name** appears identically in both places:
   ```bash
   grep -rn 'transfer:progress' src-tauri/src src/lib
   ```
4. **Types**: open `src/lib/types.ts` and the Rust `types.rs`/model file side by side. Field
   names and nullability (`Option<T>` ⇄ `T | null`) must match. Numbers: Rust `u64` ⇄ TS `number`.
5. **ConnectionConfig** is tagged with `kind` and variants `profile` / `static` (lowercase in JSON).

Report the diff, not a summary. If everything matches, say "contract check: clean".
