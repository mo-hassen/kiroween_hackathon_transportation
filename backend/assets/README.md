# Runtime assets

## common-passwords.txt

Passwords rejected by the password policy (docs/architecture/07-security-architecture.md §1).

- Source: `Passwords/Common-Credentials/100k-most-used-passwords-NCSC.txt` from
  [SecLists](https://github.com/danielmiessler/SecLists) (MIT License, Copyright (c) 2018 Daniel Miessler),
  which republishes the UK NCSC "100k most used passwords" list (from Have I Been Pwned data).
- Downloaded 2026-11-17 (99,840 lines, SHA-256 prefix `c2e5696882c603b7`).
- Processing: lower-cased, de-duplicated, printable ASCII only, and only entries of 10-128
  characters kept, because shorter passwords are already rejected by the length rule. 9,113 entries.

Regenerate with the same filter if the source list is updated. The file is loaded once at startup.
