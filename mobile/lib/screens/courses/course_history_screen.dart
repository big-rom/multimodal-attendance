import 'package:flutter/material.dart';
import '../../core/supabase_client.dart';
import 'package:intl/intl.dart';

class CourseHistoryScreen extends StatefulWidget {
  final String courseId;
  final String courseCode;
  final String courseTitle;

  const CourseHistoryScreen({
    Key? key,
    required this.courseId,
    required this.courseCode,
    required this.courseTitle,
  }) : super(key: key);

  @override
  State<CourseHistoryScreen> createState() => _CourseHistoryScreenState();
}

class _CourseHistoryScreenState extends State<CourseHistoryScreen> {
  late Future<List<dynamic>> _historyFuture;

  @override
  void initState() {
    super.initState();
    _refresh();
  }

  Future<void> _refresh() async {
    setState(() {
      _historyFuture = _fetchHistory();
    });
    await _historyFuture;
  }

  Future<List<dynamic>> _fetchHistory() async {
    final userId = SupabaseCore.client.auth.currentUser?.id;
    if (userId == null) return [];

    final response = await SupabaseCore.client
        .from('sessions')
        .select('id, session_date, starts_at, ends_at, attendance_logs(id, verification_method)')
        .eq('course_id', widget.courseId)
        .eq('attendance_logs.student_id', userId)
        .order('starts_at', ascending: false);

    return response as List<dynamic>;
  }

  Widget _buildStatusBadge(bool attended, String? method) {
    String text = attended ? 'Attended' : 'Missed';
    if (attended && method != null) {
      String prettyMethod = method == 'esp32_nfc' 
          ? 'NFC (Reader)' 
          : method == 'web_nfc' 
              ? 'NFC (Web)' 
              : method == 'qr' 
                  ? 'QR Scan' 
                  : method;
      text = 'Attended \u2022 $prettyMethod';
    }

    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
      decoration: BoxDecoration(
        color: attended ? Colors.green.withOpacity(0.1) : Colors.red.withOpacity(0.1),
        borderRadius: BorderRadius.circular(12),
        border: Border.all(
          color: attended ? Colors.green : Colors.red,
        ),
      ),
      child: Text(
        text,
        style: TextStyle(
          color: attended ? Colors.green[700] : Colors.red[700],
          fontSize: 12,
          fontWeight: FontWeight.bold,
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Text(widget.courseCode),
      ),
      body: Column(
        children: [
          Container(
            padding: const EdgeInsets.all(16),
            width: double.infinity,
            color: Colors.indigo.withOpacity(0.05),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  widget.courseTitle,
                  style: Theme.of(context).textTheme.titleLarge?.copyWith(
                        fontWeight: FontWeight.bold,
                      ),
                ),
                const SizedBox(height: 4),
                const Text(
                  'Session Attendance History',
                  style: TextStyle(color: Colors.grey),
                ),
              ],
            ),
          ),
          Expanded(
            child: RefreshIndicator(
              onRefresh: _refresh,
              child: FutureBuilder<List<dynamic>>(
                future: _historyFuture,
                builder: (context, snapshot) {
                  if (snapshot.connectionState == ConnectionState.waiting) {
                    return const Center(child: CircularProgressIndicator());
                  }

                  if (snapshot.hasError) {
                    return Center(
                      child: Text(
                        'Failed to load history.\nSwipe down to retry.',
                        textAlign: TextAlign.center,
                        style: TextStyle(color: Colors.red[400]),
                      ),
                    );
                  }

                  final sessions = snapshot.data ?? [];

                  if (sessions.isEmpty) {
                    return const Center(
                      child: Text(
                        'No sessions recorded for this course yet.',
                        style: TextStyle(color: Colors.grey, fontSize: 16),
                      ),
                    );
                  }

                  return ListView.separated(
                    itemCount: sessions.length,
                    separatorBuilder: (context, index) => const Divider(height: 1),
                    itemBuilder: (context, index) {
                      final session = sessions[index];
                      final logs = session['attendance_logs'] as List<dynamic>? ?? [];
                      final bool attended = logs.isNotEmpty;
                      final String? method = attended ? logs.first['verification_method'] : null;

                      final DateTime startsAt = DateTime.parse(session['starts_at']).toLocal();
                      final String dateStr = DateFormat('MMM d, yyyy').format(startsAt);
                      final String timeStr = DateFormat('h:mm a').format(startsAt);
                      final bool isActive = session['ends_at'] == null;

                      return ListTile(
                        contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
                        leading: CircleAvatar(
                          backgroundColor: attended 
                              ? Colors.green.withOpacity(0.2) 
                              : Colors.red.withOpacity(0.2),
                          child: Icon(
                            attended ? Icons.check_circle : Icons.cancel,
                            color: attended ? Colors.green : Colors.red,
                          ),
                        ),
                        title: Row(
                          children: [
                            Text(
                              dateStr,
                              style: const TextStyle(fontWeight: FontWeight.bold),
                            ),
                            if (isActive) ...[
                              const SizedBox(width: 8),
                              Container(
                                padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                                decoration: BoxDecoration(
                                  color: Colors.blue.withOpacity(0.1),
                                  borderRadius: BorderRadius.circular(4),
                                ),
                                child: Text(
                                  'ACTIVE',
                                  style: TextStyle(
                                    fontSize: 10,
                                    fontWeight: FontWeight.bold,
                                    color: Colors.blue[700],
                                  ),
                                ),
                              ),
                            ]
                          ],
                        ),
                        subtitle: Text(timeStr),
                        trailing: _buildStatusBadge(attended, method),
                      );
                    },
                  );
                },
              ),
            ),
          ),
        ],
      ),
    );
  }
}
