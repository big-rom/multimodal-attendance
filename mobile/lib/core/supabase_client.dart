import 'package:supabase_flutter/supabase_flutter.dart';

class SupabaseCore {
  // Configured with the project URL and Anon Key from the dashboard's .env.local
  static const String _supabaseUrl = 'https://egsjtkvojodpvatinkyv.supabase.co';
  static const String _supabaseAnonKey = 'sb_publishable_6V5YGeztuh9aWQkGQ-hqtg_wFx0yljd';

  static Future<void> initialize() async {
    await Supabase.initialize(
      url: _supabaseUrl,
      anonKey: _supabaseAnonKey,
    );
  }

  static SupabaseClient get client => Supabase.instance.client;
}
