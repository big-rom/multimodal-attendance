import 'dart:convert';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:connectivity_plus/connectivity_plus.dart';

class CacheService {
  /// Retrieves cached data from local storage.
  static Future<T?> get<T>({
    required String key,
    required T Function(dynamic json) fromJson,
  }) async {
    try {
      final prefs = await SharedPreferences.getInstance();
      final cachedString = prefs.getString(key);
      if (cachedString != null) {
        final decoded = jsonDecode(cachedString);
        return fromJson(decoded);
      }
    } catch (e) {
      // Ignore cache decode errors
    }
    return null;
  }

  /// Saves data to local storage for offline use.
  static Future<void> set<T>({
    required String key,
    required T data,
    required dynamic Function(T data) toJson,
  }) async {
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString(key, jsonEncode(toJson(data)));
    } catch (e) {
      // Ignore cache write errors
    }
  }

  /// Removes a cached key from local storage.
  static Future<void> remove(String key) async {
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.remove(key);
    } catch (_) {}
  }

  /// Checks if the device has an active network connection.
  static Future<bool> isOnline() async {
    try {
      final connectivityResults = await Connectivity().checkConnectivity();
      return !connectivityResults.contains(ConnectivityResult.none);
    } catch (_) {
      return true;
    }
  }
}
