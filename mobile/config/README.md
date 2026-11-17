# Build configuration

Public, build-time values only, passed with `--dart-define-from-file`:

```sh
flutter run --dart-define-from-file=config/development.json
```

- `development.json`: Android emulator talking to the local API (`10.0.2.2` is the host machine).
- `staging.json` / `production.json`: create from `production.example.json` when those
  environments exist (Phase 23). They must use `https`; the app refuses to start otherwise.

Never put secrets here. Everything in these files is readable inside the APK.
