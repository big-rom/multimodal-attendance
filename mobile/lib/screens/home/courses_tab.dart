import 'package:flutter/material.dart';
import '../../core/supabase_client.dart';
import '../courses/course_history_screen.dart';
import 'available_courses_screen.dart';
import '../../services/cache_service.dart';

class CoursesTab extends StatefulWidget {
  const CoursesTab({Key? key}) : super(key: key);

  @override
  State<CoursesTab> createState() => _CoursesTabState();
}

class _CoursesTabState extends State<CoursesTab> {
  List<dynamic>? _courses;
  bool _isLoading = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    _loadData();
  }

  Future<void> _loadData() async {
    // 1. Immediately display cached courses if available
    final cached = await CacheService.get<List<dynamic>>(
      key: 'courses_tab_enrollments',
      fromJson: (json) => json as List<dynamic>,
    );

    if (mounted && cached != null) {
      setState(() {
        _courses = cached;
        _isLoading = false;
      });
    }

    // 2. Fetch fresh data
    await _refresh();
  }

  Future<void> _refresh() async {
    try {
      final fresh = await _fetchCourses();
      await CacheService.set<List<dynamic>>(
        key: 'courses_tab_enrollments',
        data: fresh,
        toJson: (data) => data,
      );

      if (mounted) {
        setState(() {
          _courses = fresh;
          _isLoading = false;
          _error = null;
        });
      }
    } catch (e) {
      if (mounted) {
        setState(() {
          _isLoading = false;
          if (_courses == null) {
            _error = 'Failed to load courses.\nSwipe down to retry.';
          }
        });
      }
    }
  }

  Future<List<dynamic>> _fetchCourses() async {
    final userId = SupabaseCore.client.auth.currentUser?.id;
    if (userId == null) return [];

    final response = await SupabaseCore.client
        .from('course_enrollments')
        .select('status, rejection_reason, courses(id, course_code, course_title)')
        .eq('student_id', userId);

    return response as List<dynamic>;
  }

  void _showRejectionReason(BuildContext context, Map<String, dynamic> enrollment) {
    showDialog(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Enrollment Rejected', style: TextStyle(color: Colors.redAccent)),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text(
              'Your enrollment request for this course was rejected.',
              style: TextStyle(fontSize: 14),
            ),
            const SizedBox(height: 16),
            const Text(
              'Reason:',
              style: TextStyle(fontWeight: FontWeight.bold, fontSize: 14),
            ),
            const SizedBox(height: 4),
            Container(
              width: double.infinity,
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: Colors.red.withOpacity(0.1),
                borderRadius: BorderRadius.circular(8),
                border: Border.all(color: Colors.red.withOpacity(0.3)),
              ),
              child: Text(
                enrollment['rejection_reason'] ?? 'No reason provided.',
                style: const TextStyle(fontSize: 14, fontStyle: FontStyle.italic),
              ),
            ),
          ],
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: const Text('Cancel'),
          ),
          ElevatedButton(
            onPressed: () async {
              final messenger = ScaffoldMessenger.of(context);
              Navigator.pop(context);
              // Re-request enrollment
              try {
                await SupabaseCore.client.rpc('request_course_enrollment', params: {
                  'p_course_id': enrollment['courses']['id'],
                });
                _refresh();
                messenger.showSnackBar(
                  const SnackBar(content: Text('Re-requested successfully!')),
                );
              } catch (e) {
                messenger.showSnackBar(
                  const SnackBar(content: Text('Failed to re-request.')),
                );
              }
            },
            child: const Text('Re-Request'),
          ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('My Courses'),
      ),
      body: RefreshIndicator(
        onRefresh: _refresh,
        child: _buildBody(),
      ),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: () {
          Navigator.push(
            context,
            MaterialPageRoute(
              builder: (context) => const AvailableCoursesScreen(),
            ),
          ).then((_) => _refresh());
        },
        icon: const Icon(Icons.add),
        label: const Text('Join Course'),
        backgroundColor: Colors.indigo,
      ),
    );
  }

  Widget _buildBody() {
    if (_isLoading && _courses == null) {
      return const Center(child: CircularProgressIndicator());
    }

    if (_error != null && _courses == null) {
      return Center(
        child: Text(
          _error!,
          textAlign: TextAlign.center,
          style: TextStyle(color: Colors.red[400]),
        ),
      );
    }

    final courses = _courses ?? [];

    if (courses.isEmpty) {
      return const Center(
        child: Text(
          'You have no course requests.',
          style: TextStyle(color: Colors.grey, fontSize: 16),
        ),
      );
    }

    return ListView.separated(
      physics: const AlwaysScrollableScrollPhysics(),
      itemCount: courses.length,
      separatorBuilder: (context, index) => const Divider(height: 1),
      itemBuilder: (context, index) {
        final enrollment = courses[index];
        final course = (enrollment['courses'] as Map<String, dynamic>?) ?? 
            {'id': '', 'course_code': 'Course hidden', 'course_title': 'Course hidden by permissions'};
        final status = enrollment['status'] as String;

        Widget trailingWidget;
        if (status == 'pending') {
          trailingWidget = const Chip(
            label: Text('Pending', style: TextStyle(fontSize: 12, color: Colors.orange)),
            backgroundColor: Colors.orangeAccent,
          );
        } else if (status == 'rejected') {
          trailingWidget = const Chip(
            label: Text('Rejected', style: TextStyle(fontSize: 12, color: Colors.white)),
            backgroundColor: Colors.red,
          );
        } else {
          trailingWidget = const Icon(Icons.chevron_right);
        }

        return ListTile(
          contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
          leading: CircleAvatar(
            backgroundColor: status == 'approved' ? Colors.indigo : Colors.grey,
            child: const Icon(Icons.book, color: Colors.white),
          ),
          title: Text(
            course['course_code'],
            style: const TextStyle(fontWeight: FontWeight.bold),
          ),
          subtitle: Text(course['course_title']),
          trailing: trailingWidget,
          onTap: () {
            if (status == 'approved') {
              Navigator.of(context).push(
                MaterialPageRoute(
                  builder: (context) => CourseHistoryScreen(
                    courseId: course['id'],
                    courseCode: course['course_code'],
                    courseTitle: course['course_title'],
                  ),
                ),
              );
            } else if (status == 'rejected') {
              _showRejectionReason(context, enrollment);
            } else {
              ScaffoldMessenger.of(context).showSnackBar(
                const SnackBar(content: Text('Your enrollment is pending approval.')),
              );
            }
          },
        );
      },
    );
  }
}
