import 'package:flutter/material.dart';
import '../../models/course_result.dart';
import '../../services/gpa_service.dart';

class CourseManagementTab extends StatefulWidget {
  const CourseManagementTab({super.key});

  @override
  State<CourseManagementTab> createState() => _CourseManagementTabState();
}

class _CourseManagementTabState extends State<CourseManagementTab> {
  final GpaService _gpaService = GpaService();
  List<CourseResult> _results = [];
  bool _isLoading = true;

  @override
  void initState() {
    super.initState();
    _loadData();
  }

  Future<void> _loadData() async {
    setState(() => _isLoading = true);
    final results = await _gpaService.loadResults();
    setState(() {
      _results = results;
      _isLoading = false;
    });
  }

  void _showAddDialog() {
    final formKey = GlobalKey<FormState>();
    String code = '';
    int credits = 3;
    String grade = 'A';
    int semester = 1;
    int level = 100;

    showDialog(
      context: context,
      builder: (context) {
        return AlertDialog(
          title: const Text('Add Course Result'),
          content: Form(
            key: formKey,
            child: SingleChildScrollView(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  TextFormField(
                    decoration: const InputDecoration(
                      labelText: 'Course Code',
                      hintText: 'e.g. MTH 101',
                    ),
                    textCapitalization: TextCapitalization.characters,
                    validator: (val) => val == null || val.isEmpty ? 'Required' : null,
                    onSaved: (val) => code = val!.trim().toUpperCase(),
                  ),
                  const SizedBox(height: 12),
                  Row(
                    children: [
                      Expanded(
                        child: DropdownButtonFormField<int>(
                          decoration: const InputDecoration(labelText: 'Credit Units'),
                          initialValue: credits,
                          items: [1, 2, 3, 4, 5, 6].map((e) => DropdownMenuItem(value: e, child: Text(e.toString()))).toList(),
                          onChanged: (val) => credits = val ?? 3,
                        ),
                      ),
                      const SizedBox(width: 12),
                      Expanded(
                        child: DropdownButtonFormField<String>(
                          decoration: const InputDecoration(labelText: 'Grade'),
                          initialValue: grade,
                          items: ['A', 'B', 'C', 'D', 'E', 'F'].map((e) => DropdownMenuItem(value: e, child: Text(e))).toList(),
                          onChanged: (val) => grade = val ?? 'A',
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 12),
                  DropdownButtonFormField<int>(
                    decoration: const InputDecoration(labelText: 'Level'),
                    initialValue: level,
                    items: [100, 200, 300, 400, 500, 600].map((e) => DropdownMenuItem(value: e, child: Text('$e Level'))).toList(),
                    onChanged: (val) => level = val ?? 100,
                  ),
                  const SizedBox(height: 12),
                  DropdownButtonFormField<int>(
                    decoration: const InputDecoration(labelText: 'Semester'),
                    initialValue: semester,
                    items: const [
                      DropdownMenuItem(
                        value: 1,
                        child: Text('Harmattan Semester'),
                      ),
                      DropdownMenuItem(
                        value: 2,
                        child: Text('Rain Semester'),
                      ),
                    ],
                    onChanged: (val) => semester = val ?? 1,
                  ),
                ],
              ),
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(context),
              child: const Text('Cancel'),
            ),
            FilledButton(
              onPressed: () async {
                if (formKey.currentState!.validate()) {
                  formKey.currentState!.save();
                  final newResult = CourseResult(
                    id: DateTime.now().millisecondsSinceEpoch.toString(),
                    code: code,
                    credits: credits,
                    gradePoints: CourseResult.getGradePoints(grade),
                    semester: semester,
                    level: level,
                  );
                  Navigator.pop(context);
                  await _gpaService.addResult(newResult);
                  _loadData();
                }
              },
              child: const Text('Save'),
            ),
          ],
        );
      },
    );
  }

  @override
  Widget build(BuildContext context) {
    if (_isLoading) {
      return const Scaffold(body: Center(child: CircularProgressIndicator()));
    }

    final cgpa = _gpaService.calculateGPA(_results);

    return Scaffold(
      appBar: AppBar(
        title: const Text('Course Management'),
        actions: [
          if (_results.isNotEmpty)
            IconButton(
              icon: const Icon(Icons.delete_sweep),
              onPressed: () async {
                final confirm = await showDialog<bool>(
                  context: context,
                  builder: (c) => AlertDialog(
                    title: const Text('Clear All?'),
                    content: const Text('This will delete all saved results locally.'),
                    actions: [
                      TextButton(onPressed: () => Navigator.pop(c, false), child: const Text('Cancel')),
                      FilledButton(onPressed: () => Navigator.pop(c, true), child: const Text('Clear')),
                    ],
                  ),
                );
                if (confirm == true) {
                  await _gpaService.clearAll();
                  _loadData();
                }
              },
            ),
        ],
      ),
      body: Column(
        children: [
          Container(
            padding: const EdgeInsets.all(24),
            width: double.infinity,
            color: Theme.of(context).colorScheme.primaryContainer,
            child: Column(
              children: [
                const Text('Cumulative GPA (CGPA)', style: TextStyle(fontSize: 16)),
                const SizedBox(height: 8),
                Text(
                  cgpa.toStringAsFixed(2),
                  style: const TextStyle(fontSize: 48, fontWeight: FontWeight.bold),
                ),
                const SizedBox(height: 8),
                const Text('5-Point Scale', style: TextStyle(fontSize: 12, color: Colors.grey)),
              ],
            ),
          ),
          Expanded(
            child: _results.isEmpty
                ? Center(
                    child: Column(
                      mainAxisAlignment: MainAxisAlignment.center,
                      children: [
                        Icon(Icons.school_outlined, size: 64, color: Colors.grey[400]),
                        const SizedBox(height: 16),
                        const Text('No courses added yet', style: TextStyle(fontSize: 18, fontWeight: FontWeight.bold)),
                        const SizedBox(height: 8),
                        const Text('Tap + to add a course result', style: TextStyle(color: Colors.grey)),
                      ],
                    ),
                  )
                : ListView.builder(
                    itemCount: _results.length,
                    itemBuilder: (context, index) {
                      final r = _results[index];
                      return Dismissible(
                        key: Key(r.id),
                        background: Container(
                          color: Colors.red,
                          alignment: Alignment.centerRight,
                          padding: const EdgeInsets.only(right: 16),
                          child: const Icon(Icons.delete, color: Colors.white),
                        ),
                        direction: DismissDirection.endToStart,
                        onDismissed: (_) async {
                          await _gpaService.removeResult(r.id);
                          _loadData();
                        },
                        child: ListTile(
                          title: Text(r.code, style: const TextStyle(fontWeight: FontWeight.bold)),
                          subtitle: Text('${r.credits} Credits • ${r.level} Level • ${CourseResult.getSemesterName(r.semester)}'),
                          trailing: Container(
                            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
                            decoration: BoxDecoration(
                              color: Theme.of(context).colorScheme.secondaryContainer,
                              borderRadius: BorderRadius.circular(8),
                            ),
                            child: Text(
                              CourseResult.getGradeString(r.gradePoints),
                              style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 16),
                            ),
                          ),
                        ),
                      );
                    },
                  ),
          ),
        ],
      ),
      floatingActionButton: FloatingActionButton(
        onPressed: _showAddDialog,
        child: const Icon(Icons.add),
      ),
    );
  }
}
