/// Route paths. Deep links are matched only against these patterns; anything
/// else lands on the not-found screen (docs/architecture/06-flutter-architecture.md).
abstract final class AppRoutes {
  static const root = '/';
  static const splash = '/splash';
  static const welcome = '/welcome';
  static const login = '/login';
  static const loginVerify = '/login/verify';
  static const register = '/register';
  static const forgotPassword = '/forgot-password';
  static const account = '/account';
  static const accountSessions = '/account/sessions';
  static const accountPassword = '/account/password';
  static const identity = '/identity';

  /// Where the browser returns after the identity provider (App Link / app scheme). Carries
  /// only `?verification=<id>`; the screen reads the result from the server.
  static const identityReturn = '/identity/return';

  /// Driver onboarding (Phase 5).
  static const driver = '/driver';
  static const driverProfile = '/driver/profile';
  static const driverLicense = '/driver/license';
  static const driverPhotos = '/driver/license/photos';
  static const driverReview = '/driver/license/review';

  /// Owner onboarding (Phase 6).
  static const owner = '/owner';
  static const ownerDetails = '/owner/details';
  static const ownerDocuments = '/owner/documents';
  static const ownerReview = '/owner/review';

  /// Vehicles (Phase 7). The id routes carry a UUID; [isVehicleRoute] matches them.
  static const vehicles = '/vehicles';
  static const vehicleNew = '/vehicles/new';
  static String vehicle(String id) => '/vehicles/$id';
  static String vehicleEdit(String id) => '/vehicles/$id/edit';
  static String vehicleReview(String id) => '/vehicles/$id/review';

  static final _vehicleRoute = RegExp(
    r'^/vehicles/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}(/edit|/review)?$',
  );

  /// `/vehicles/<uuid>`, `/vehicles/<uuid>/edit` and `/vehicles/<uuid>/review`.
  static bool isVehicleRoute(String location) => _vehicleRoute.hasMatch(location);

  /// Every route the guard knows, including the vehicle id routes.
  static bool isKnown(String location) => all.contains(location) || isVehicleRoute(location);

  /// Reachable without a session.
  static const signedOutRoutes = {welcome, login, loginVerify, register, forgotPassword};

  /// Every route the guard knows. Anything else is left to the not-found screen.
  static const all = {
    root,
    splash,
    ...signedOutRoutes,
    account,
    accountSessions,
    accountPassword,
    identity,
    identityReturn,
    driver,
    driverProfile,
    driverLicense,
    driverPhotos,
    driverReview,
    owner,
    ownerDetails,
    ownerDocuments,
    ownerReview,
    vehicles,
    vehicleNew,
  };
}
