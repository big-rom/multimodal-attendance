import 'package:flutter/foundation.dart';
import 'package:supabase_flutter/supabase_flutter.dart';
import '../core/supabase_client.dart';
import '../models/profile.dart';
import 'dart:io';
import 'dart:math';
import 'package:device_info_plus/device_info_plus.dart';
import 'package:shared_preferences/shared_preferences.dart';

class AuthProvider extends ChangeNotifier {
  final SupabaseClient _client = SupabaseCore.client;
  
  User? _user;
  Profile? _profile;
  bool _isLoading = true;
  String? _error;

  User? get user => _user;
  Profile? get profile => _profile;
  bool get isLoading => _isLoading;
  String? get error => _error;
  bool get isAuthenticated => _user != null && _profile != null && _profile!.role == 'student';

  AuthProvider() {
    _init();
  }

  Future<void> _init() async {
    _client.auth.onAuthStateChange.listen((data) async {
      final AuthChangeEvent event = data.event;
      final Session? session = data.session;

      _isLoading = true;
      notifyListeners();

      if (event == AuthChangeEvent.signedIn || event == AuthChangeEvent.initialSession) {
        _user = session?.user;
        if (_user != null) {
          await _fetchProfileAndVerifyRole();
        } else {
          _clearState();
        }
      } else if (event == AuthChangeEvent.signedOut) {
        _clearState();
      }

      _isLoading = false;
      notifyListeners();
    });
  }

  Future<String> _getDeviceId() async {
    final prefs = await SharedPreferences.getInstance();
    String? localUuid = prefs.getString('student_device_unique_uuid');
    if (localUuid == null || localUuid.isEmpty) {
      final randomNum = Random().nextInt(999999);
      localUuid = '${DateTime.now().millisecondsSinceEpoch}_$randomNum';
      await prefs.setString('student_device_unique_uuid', localUuid);
    }

    final DeviceInfoPlugin deviceInfo = DeviceInfoPlugin();
    String hardware = '';
    try {
      if (Platform.isAndroid) {
        final androidInfo = await deviceInfo.androidInfo;
        hardware = '${androidInfo.brand}_${androidInfo.model}_${androidInfo.id}';
      } else if (Platform.isIOS) {
        final iosInfo = await deviceInfo.iosInfo;
        hardware = iosInfo.identifierForVendor ?? 'ios';
      }
    } catch (e) {
      debugPrint('Error getting device info: $e');
    }

    if (hardware.isNotEmpty) {
      return '${hardware}_$localUuid';
    }
    return 'device_$localUuid';
  }

  Future<void> _fetchProfileAndVerifyRole() async {
    try {
      final response = await _client
          .from('profiles')
          .select()
          .eq('id', _user!.id)
          .single();
      
      _profile = Profile.fromJson(response);

      if (_profile?.role != 'student') {
        _error = 'This app is for students only. Please use the dashboard.';
        await signOut();
        return;
      }

      // Check device binding
      final currentDeviceId = await _getDeviceId();

      if (_profile?.deviceId == null || _profile!.deviceId!.isEmpty) {
        // First login: bind this phone to the account
        try {
          final res = await _client.rpc('bind_student_device', params: {
            'p_device_id': currentDeviceId,
          });
          final bool bound = (res == true);
          if (!bound) {
            _error = 'Failed to bind device. This account may already be bound to another phone.';
            await signOut();
            return;
          }
        } catch (e) {
          debugPrint('Error binding device via RPC, fallback to direct update: $e');
          await _client
              .from('profiles')
              .update({'device_id': currentDeviceId})
              .eq('id', _user!.id);
        }

        // Update local profile instance with bound deviceId
        _profile = Profile(
          id: _profile!.id,
          fullName: _profile!.fullName,
          role: _profile!.role,
          matricNumber: _profile!.matricNumber,
          deviceId: currentDeviceId,
        );
      } else if (_profile?.deviceId != currentDeviceId) {
        // Bound to a different device!
        _error = 'This account is bound to another device. Please use your registered phone or contact an administrator.';
        await signOut();
        return;
      }

      _error = null;
    } catch (e) {
      _error = 'Failed to load user profile.';
      await signOut();
    }
  }

  Future<bool> signUp(
    String email,
    String password,
    String surname,
    String firstname,
    String otherNames,
    String matricNumber,
  ) async {
    try {
      _isLoading = true;
      _error = null;
      notifyListeners();

      final fullNameParts = [surname.trim(), firstname.trim()];
      if (otherNames.trim().isNotEmpty) fullNameParts.add(otherNames.trim());
      final fullName = fullNameParts.join(' ');

      await _client.auth.signUp(
        email: email.trim(),
        password: password,
        data: {
          'full_name': fullName,
          'surname': surname.trim(),
          'firstname': firstname.trim(),
          if (otherNames.trim().isNotEmpty) 'other_names': otherNames.trim(),
          'matric_number': matricNumber.trim().toUpperCase(),
        },
      );
      
      return true;
    } on AuthException catch (e) {
      final msg = e.message.toLowerCase();
      if (msg.contains('user already registered')) {
        _error = 'An account with this email already exists.';
      } else if (msg.contains('database error') ||
                 msg.contains('chk_matric_format') ||
                 msg.contains('violates check constraint')) {
        _error = 'Please check your registration details. Matric number must follow the format XXX/YYYY/NNN (e.g. MEE/2021/045).';
      } else {
        _error = e.message;
      }
      return false;
    } on PostgrestException catch (e) {
      final msg = e.message.toLowerCase();
      if (msg.contains('matric_number_key') || e.code == '23505') {
        _error = 'This matric number is already registered.';
      } else if (msg.contains('chk_matric_format') || msg.contains('check constraint')) {
        _error = 'Please check your registration details. Matric number must follow the format XXX/YYYY/NNN (e.g. MEE/2021/045).';
      } else {
        _error = e.message;
      }
      return false;
    } catch (e) {
      final str = e.toString().toLowerCase();
      if (str.contains('matric_number_key') || str.contains('duplicate key')) {
        _error = 'This matric number is already registered.';
      } else if (str.contains('chk_matric_format') || str.contains('check constraint') || str.contains('database error')) {
        _error = 'Please check your registration details. Matric number must follow the format XXX/YYYY/NNN (e.g. MEE/2021/045).';
      } else {
        _error = 'An unexpected error occurred. Please check your credentials and try again.';
      }
      return false;
    } finally {
      _isLoading = false;
      notifyListeners();
    }
  }

  Future<bool> signIn(String email, String password) async {
    try {
      _isLoading = true;
      _error = null;
      notifyListeners();

      await _client.auth.signInWithPassword(
        email: email.trim(),
        password: password,
      );
      return true;
    } on AuthException catch (e) {
      final msg = e.message.toLowerCase();
      if (msg.contains('invalid login credentials')) {
        _error = 'Invalid email or password. Please check your credentials and try again.';
      } else {
        _error = e.message;
      }
      return false;
    } catch (e) {
      _error = 'An unexpected error occurred. Please check your connection and try again.';
      return false;
    } finally {
      _isLoading = false;
      notifyListeners();
    }
  }

  Future<void> signOut() async {
    await _client.auth.signOut();
  }

  void clearError() {
    _error = null;
    notifyListeners();
  }

  void _clearState() {
    _user = null;
    _profile = null;
  }
}
