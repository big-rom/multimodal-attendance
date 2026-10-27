import 'dart:convert';
import 'package:shared_preferences/shared_preferences.dart';
import '../models/course_result.dart';

class GpaService {
  static const String _storageKey = 'student_course_results';

  Future<List<CourseResult>> loadResults() async {
    final prefs = await SharedPreferences.getInstance();
    final String? dataString = prefs.getString(_storageKey);
    if (dataString == null) return [];

    try {
      final List<dynamic> jsonList = jsonDecode(dataString);
      return jsonList.map((e) => CourseResult.fromJson(e)).toList();
    } catch (e) {
      print('Error parsing results: $e');
      return [];
    }
  }

  Future<void> saveResults(List<CourseResult> results) async {
    final prefs = await SharedPreferences.getInstance();
    final List<Map<String, dynamic>> jsonList = results.map((e) => e.toJson()).toList();
    await prefs.setString(_storageKey, jsonEncode(jsonList));
  }

  Future<void> addResult(CourseResult result) async {
    final results = await loadResults();
    results.add(result);
    await saveResults(results);
  }

  Future<void> removeResult(String id) async {
    final results = await loadResults();
    results.removeWhere((r) => r.id == id);
    await saveResults(results);
  }

  Future<void> clearAll() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove(_storageKey);
  }

  double calculateGPA(List<CourseResult> results) {
    if (results.isEmpty) return 0.0;
    int totalCredits = 0;
    int totalPoints = 0;
    
    for (var r in results) {
      totalCredits += r.credits;
      totalPoints += (r.credits * r.gradePoints);
    }
    
    if (totalCredits == 0) return 0.0;
    return totalPoints / totalCredits;
  }
}
