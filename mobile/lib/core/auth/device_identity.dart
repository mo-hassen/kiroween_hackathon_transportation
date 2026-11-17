import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:uuid/uuid.dart';

import '../config/app_info.dart';

/// Random per-installation id, so the server can recognise this device (trusted devices
/// skip the new-device SMS code). Not secret, but kept in secure storage with the
/// session so both disappear together on uninstall.
abstract interface class InstallationIdStore {
  Future<String> installationId();
}

final class SecureInstallationIdStore implements InstallationIdStore {
  SecureInstallationIdStore([FlutterSecureStorage? storage])
    : _storage = storage ?? const FlutterSecureStorage();

  static const _key = 'device.installation_id';
  final FlutterSecureStorage _storage;
  String? _cached;

  @override
  Future<String> installationId() async {
    final cached = _cached;
    if (cached != null) return cached;
    final stored = await _storage.read(key: _key);
    if (stored != null && stored.length >= 8) return _cached = stored;
    final created = const Uuid().v4();
    await _storage.write(key: _key, value: created);
    return _cached = created;
  }
}

/// Device description sent with sign-in requests.
final class DeviceDescriptor {
  const DeviceDescriptor({required this.installationId, required this.platform});

  final String installationId;
  final String platform;

  Map<String, Object> toJson() => {
    'installationId': installationId,
    'platform': platform,
    'appVersion': appVersion,
  };
}

String currentPlatform() => switch (defaultTargetPlatform) {
  _ when kIsWeb => 'WEB',
  TargetPlatform.iOS => 'IOS',
  TargetPlatform.android => 'ANDROID',
  _ => 'ANDROID',
};

final installationIdStoreProvider = Provider<InstallationIdStore>(
  (ref) => SecureInstallationIdStore(),
);

final deviceDescriptorProvider = FutureProvider<DeviceDescriptor>((ref) async {
  final id = await ref.watch(installationIdStoreProvider).installationId();
  return DeviceDescriptor(installationId: id, platform: currentPlatform());
});
