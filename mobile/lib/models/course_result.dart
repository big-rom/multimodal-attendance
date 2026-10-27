class CourseResult {
  final String id;
  final String code;
  final int credits;
  final int gradePoints;
  final int semester;
  final int level;

  CourseResult({
    required this.id,
    required this.code,
    required this.credits,
    required this.gradePoints,
    required this.semester,
    required this.level,
  });

  Map<String, dynamic> toJson() {
    return {
      'id': id,
      'code': code,
      'credits': credits,
      'gradePoints': gradePoints,
      'semester': semester,
      'level': level,
    };
  }

  factory CourseResult.fromJson(Map<String, dynamic> json) {
    return CourseResult(
      id: json['id'],
      code: json['code'],
      credits: json['credits'],
      gradePoints: json['gradePoints'],
      semester: json['semester'],
      level: json['level'],
    );
  }

  // 5-point grading scale mapping
  static int getGradePoints(String grade) {
    switch (grade.toUpperCase()) {
      case 'A': return 5;
      case 'B': return 4;
      case 'C': return 3;
      case 'D': return 2;
      case 'E': return 1;
      case 'F': return 0;
      default: return 0;
    }
  }

  static String getGradeString(int points) {
    switch (points) {
      case 5: return 'A';
      case 4: return 'B';
      case 3: return 'C';
      case 2: return 'D';
      case 1: return 'E';
      case 0: return 'F';
      default: return 'F';
    }
  }

  static String getSemesterName(int semester, {bool full = true}) {
    if (semester == 1) {
      return full ? 'Harmattan Semester' : 'Harmattan';
    } else {
      return full ? 'Rain Semester' : 'Rain';
    }
  }
}
