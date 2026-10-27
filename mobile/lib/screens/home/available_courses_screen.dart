import 'package:flutter/material.dart';
import '../../core/supabase_client.dart';

class AvailableCoursesScreen extends StatefulWidget {
  const AvailableCoursesScreen({Key? key}) : super(key: key);

  @override
  State<AvailableCoursesScreen> createState() => _AvailableCoursesScreenState();
}

class _AvailableCoursesScreenState extends State<AvailableCoursesScreen> {
  late Future<List<dynamic>> _coursesFuture;
  String? _requestingCourseId;

  @override
  void initState() {
    super.initState();
    _coursesFuture = _fetchAvailableCourses();
  }

  Future<List<dynamic>> _fetchAvailableCourses() async {
    final userId = SupabaseCore.client.auth.currentUser?.id;
    // We select from the secure view 'available_courses'
    final response = await SupabaseCore.client
        .from('available_courses')
        .select('*')
        .order('course_code');
        
    final courses = List<Map<String, dynamic>>.from(response as List);
    
    if (userId != null) {
      final enrollments = await SupabaseCore.client
          .from('course_enrollments')
          .select('course_id, status')
          .eq('student_id', userId);
          
      final enrollmentMap = {
        for (var e in enrollments as List) e['course_id']: e['status']
      };
      
      for (var i = 0; i < courses.length; i++) {
        final courseId = courses[i]['id'];
        if (enrollmentMap.containsKey(courseId)) {
          courses[i]['enrollment_status'] = enrollmentMap[courseId];
        }
      }
    }
    
    return courses;
  }

  Future<void> _requestEnrollment(String courseId) async {
    setState(() => _requestingCourseId = courseId);
    try {
      await SupabaseCore.client.rpc('request_course_enrollment', params: {
        'p_course_id': courseId,
      });
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text('Enrollment requested successfully!'),
            backgroundColor: Colors.green,
          ),
        );
        Navigator.pop(context); // Go back to courses tab
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text('Failed to request enrollment: $e'),
            backgroundColor: Colors.redAccent,
          ),
        );
      }
    } finally {
      if (mounted) {
        setState(() => _requestingCourseId = null);
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Join a Course'),
      ),
      body: FutureBuilder<List<dynamic>>(
        future: _coursesFuture,
        builder: (context, snapshot) {
          if (snapshot.connectionState == ConnectionState.waiting) {
            return const Center(child: CircularProgressIndicator());
          }

          if (snapshot.hasError) {
            return Center(
              child: Text(
                'Failed to load courses.\n${snapshot.error}',
                textAlign: TextAlign.center,
                style: TextStyle(color: Colors.red[400]),
              ),
            );
          }

          final courses = snapshot.data ?? [];

          if (courses.isEmpty) {
            return const Center(
              child: Text(
                'No courses available at this time.',
                style: TextStyle(color: Colors.grey, fontSize: 16),
              ),
            );
          }

          return ListView.separated(
            padding: const EdgeInsets.symmetric(vertical: 8),
            itemCount: courses.length,
            separatorBuilder: (context, index) => const Divider(height: 1),
            itemBuilder: (context, index) {
              final course = courses[index];
              Widget buildTrailing() {
                if (_requestingCourseId == course['id']) {
                  return const SizedBox(
                    width: 24,
                    height: 24,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  );
                }
                final status = course['enrollment_status'];
                if (status == 'approved') {
                  return const Chip(
                    label: Text('Enrolled', style: TextStyle(fontSize: 12, color: Colors.white)),
                    backgroundColor: Colors.green,
                  );
                } else if (status == 'pending') {
                  return const Chip(
                    label: Text('Pending', style: TextStyle(fontSize: 12, color: Colors.orange)),
                    backgroundColor: Colors.orangeAccent,
                  );
                } else if (status == 'rejected') {
                  return const Chip(
                    label: Text('Rejected', style: TextStyle(fontSize: 12, color: Colors.white)),
                    backgroundColor: Colors.red,
                  );
                } else {
                  return ElevatedButton(
                    onPressed: () => _requestEnrollment(course['id']),
                    style: ElevatedButton.styleFrom(
                      backgroundColor: Colors.indigo,
                      foregroundColor: Colors.white,
                    ),
                    child: const Text('Request'),
                  );
                }
              }

              return ListTile(
                contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
                title: Text(
                  course['course_code'],
                  style: const TextStyle(fontWeight: FontWeight.bold),
                ),
                subtitle: Text(
                  '${course['course_title']}\nLecturer: ${course['coordinator_full_name']}',
                ),
                isThreeLine: true,
                trailing: buildTrailing(),
              );
            },
          );
        },
      ),
    );
  }
}
