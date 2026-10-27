import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../../providers/auth_provider.dart';
import '../../providers/theme_provider.dart';
import '../../core/supabase_client.dart';
import '../../services/cache_service.dart';

class HomeTab extends StatefulWidget {
  const HomeTab({Key? key}) : super(key: key);

  @override
  State<HomeTab> createState() => _HomeTabState();
}

class _HomeTabState extends State<HomeTab> {
  List<dynamic>? _enrollments;
  List<dynamic>? _activeSessions;
  bool _isLoading = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    _loadData();
  }

  Future<void> _loadData() async {
    // 1. Immediately display cached data if available (zero wait time)
    final cachedEnrollments = await CacheService.get<List<dynamic>>(
      key: 'home_enrollments',
      fromJson: (json) => json as List<dynamic>,
    );
    final cachedSessions = await CacheService.get<List<dynamic>>(
      key: 'home_active_sessions',
      fromJson: (json) => json as List<dynamic>,
    );

    if (mounted && (cachedEnrollments != null || cachedSessions != null)) {
      setState(() {
        if (cachedEnrollments != null) _enrollments = cachedEnrollments;
        if (cachedSessions != null) _activeSessions = cachedSessions;
        _isLoading = false;
      });
    }

    // 2. Fetch fresh data in the background (or foreground if no cache)
    await _refresh();
  }

  Future<void> _refresh() async {
    try {
      final results = await Future.wait([
        _fetchEnrollments(),
        _fetchActiveSessions(),
      ]);

      final freshEnrollments = results[0];
      final freshSessions = results[1];

      // Update local cache
      await Future.wait([
        CacheService.set<List<dynamic>>(
          key: 'home_enrollments',
          data: freshEnrollments,
          toJson: (data) => data,
        ),
        CacheService.set<List<dynamic>>(
          key: 'home_active_sessions',
          data: freshSessions,
          toJson: (data) => data,
        ),
      ]);

      if (mounted) {
        setState(() {
          _enrollments = freshEnrollments;
          _activeSessions = freshSessions;
          _isLoading = false;
          _error = null;
        });
      }
    } catch (e) {
      if (mounted) {
        setState(() {
          _isLoading = false;
          if (_enrollments == null) {
            _error = 'Failed to load courses.\nSwipe down to retry.';
          }
        });
      }
    }
  }

  Future<List<dynamic>> _fetchEnrollments() async {
    final userId = SupabaseCore.client.auth.currentUser?.id;
    if (userId == null) return [];

    final response = await SupabaseCore.client
        .from('course_enrollments')
        .select('course_id, eligibility_percentage, courses(id, course_code, course_title)')
        .eq('student_id', userId)
        .eq('status', 'approved');

    return response as List<dynamic>;
  }

  Future<List<dynamic>> _fetchActiveSessions() async {
    final userId = SupabaseCore.client.auth.currentUser?.id;
    if (userId == null) return [];

    final enrollments = await SupabaseCore.client
        .from('course_enrollments')
        .select('course_id')
        .eq('student_id', userId)
        .eq('status', 'approved');
        
    final courseIds = (enrollments as List).map((e) => e['course_id']).toList();
    if (courseIds.isEmpty) return [];

    final activeSessions = await SupabaseCore.client
        .from('sessions')
        .select('id, course_id, courses(course_code), starts_at, ends_at')
        .inFilter('course_id', courseIds)
        .isFilter('ends_at', null);

    return activeSessions as List<dynamic>;
  }

  Widget _buildBadge(num percentage) {
    if (percentage < 70) {
      return const SizedBox.shrink();
    }
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
      decoration: BoxDecoration(
        color: Colors.green.withAlpha(25),
        borderRadius: BorderRadius.circular(16),
        border: Border.all(
          color: Colors.green,
        ),
      ),
      child: Text(
        'Eligible',
        style: TextStyle(
          color: Colors.green[700],
          fontWeight: FontWeight.bold,
          fontSize: 12,
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final profile = context.watch<AuthProvider>().profile;

    return Scaffold(
      appBar: AppBar(
        title: const Text('My Attendance'),
        actions: [
          IconButton(
            icon: Icon(
              context.watch<ThemeProvider>().isDarkMode 
                  ? Icons.light_mode 
                  : Icons.dark_mode,
            ),
            onPressed: () {
              context.read<ThemeProvider>().toggleTheme();
            },
          ),
          IconButton(
            icon: const Icon(Icons.logout),
            onPressed: () {
              context.read<AuthProvider>().signOut();
            },
          ),
        ],
      ),
      body: RefreshIndicator(
        onRefresh: _refresh,
        child: CustomScrollView(
          physics: const AlwaysScrollableScrollPhysics(),
          slivers: [
            if (_activeSessions != null && _activeSessions!.isNotEmpty)
              SliverToBoxAdapter(
                child: Padding(
                  padding: const EdgeInsets.fromLTRB(16, 16, 16, 0),
                  child: Container(
                    padding: const EdgeInsets.all(16),
                    decoration: BoxDecoration(
                      gradient: LinearGradient(
                        colors: [Colors.indigo.shade600, Colors.blue.shade700],
                        begin: Alignment.topLeft,
                        end: Alignment.bottomRight,
                      ),
                      borderRadius: BorderRadius.circular(16),
                      boxShadow: [
                        BoxShadow(
                          color: Colors.indigo.withOpacity(0.3),
                          blurRadius: 8,
                          offset: const Offset(0, 4),
                        )
                      ],
                    ),
                    child: Row(
                      children: [
                        Container(
                          padding: const EdgeInsets.all(12),
                          decoration: BoxDecoration(
                            color: Colors.white.withOpacity(0.2),
                            shape: BoxShape.circle,
                          ),
                          child: const Icon(Icons.sensors, color: Colors.white, size: 28),
                        ),
                        const SizedBox(width: 16),
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              const Text(
                                'Active Session Available!',
                                style: TextStyle(color: Colors.white, fontWeight: FontWeight.bold, fontSize: 18),
                              ),
                              const SizedBox(height: 4),
                              Text(
                                'A session is running right now. Tap Scan or NFC to check in.',
                                style: TextStyle(color: Colors.white.withOpacity(0.9), fontSize: 13),
                              ),
                            ],
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
              ),
            SliverToBoxAdapter(
              child: Padding(
                padding: const EdgeInsets.all(16.0),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      'Welcome, ${profile?.fullName ?? "Student"}!',
                      style: Theme.of(context).textTheme.headlineSmall?.copyWith(
                            fontWeight: FontWeight.bold,
                          ),
                    ),
                    const SizedBox(height: 4),
                    Text(
                      'Matric No: ${profile?.matricNumber ?? "N/A"}',
                      style: Theme.of(context).textTheme.bodyLarge?.copyWith(
                            color: Colors.grey[700],
                          ),
                    ),
                    const SizedBox(height: 24),
                    Text(
                      'Enrolled Courses',
                      style: Theme.of(context).textTheme.titleLarge,
                    ),
                  ],
                ),
              ),
            ),
            if (_isLoading && _enrollments == null)
              const SliverFillRemaining(
                child: Center(
                  child: CircularProgressIndicator(),
                ),
              )
            else if (_error != null && _enrollments == null)
              SliverFillRemaining(
                child: Center(
                  child: Text(
                    _error!,
                    textAlign: TextAlign.center,
                    style: TextStyle(color: Colors.red[400]),
                  ),
                ),
              )
            else if (_enrollments == null || _enrollments!.isEmpty)
              const SliverFillRemaining(
                child: Center(
                  child: Text(
                    'You are not enrolled in any courses yet.\nPull to refresh.',
                    textAlign: TextAlign.center,
                    style: TextStyle(color: Colors.grey, fontSize: 16),
                  ),
                ),
              )
            else
              SliverList(
                delegate: SliverChildBuilderDelegate(
                  (context, index) {
                    final enrollment = _enrollments![index];
                    final course = enrollment['courses'] as Map<String, dynamic>;
                    final num percentage = enrollment['eligibility_percentage'] ?? 0;

                    return Card(
                      margin: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
                      elevation: 2,
                      shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(12),
                      ),
                      child: Padding(
                        padding: const EdgeInsets.all(16.0),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Row(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Expanded(
                                  child: Column(
                                    crossAxisAlignment: CrossAxisAlignment.start,
                                    children: [
                                      Text(
                                        course['course_code'],
                                        style: const TextStyle(
                                          fontWeight: FontWeight.bold,
                                          fontSize: 16,
                                          color: Colors.indigo,
                                        ),
                                      ),
                                      const SizedBox(height: 4),
                                      Text(
                                        course['course_title'],
                                        style: const TextStyle(
                                          fontSize: 18,
                                        ),
                                      ),
                                    ],
                                  ),
                                ),
                                _buildBadge(percentage),
                              ],
                            ),
                            const SizedBox(height: 16),
                            Row(
                              mainAxisAlignment: MainAxisAlignment.spaceBetween,
                              children: [
                                const Text(
                                  'Current Attendance:',
                                  style: TextStyle(
                                    color: Colors.grey,
                                    fontWeight: FontWeight.w500,
                                  ),
                                ),
                                Text(
                                  '${percentage.toStringAsFixed(1)}%',
                                  style: const TextStyle(
                                    fontWeight: FontWeight.bold,
                                    fontSize: 16,
                                  ),
                                ),
                              ],
                            ),
                            const SizedBox(height: 8),
                            LinearProgressIndicator(
                              value: (percentage / 100).clamp(0.0, 1.0),
                              backgroundColor: Colors.grey[200],
                              color: percentage >= 70 ? Colors.green : Colors.indigo,
                              minHeight: 8,
                              borderRadius: BorderRadius.circular(4),
                            ),
                          ],
                        ),
                      ),
                    );
                  },
                  childCount: _enrollments!.length,
                ),
              ),
            // Bottom padding for scrolling
            const SliverToBoxAdapter(child: SizedBox(height: 24)),
          ],
        ),
      ),
    );
  }
}
