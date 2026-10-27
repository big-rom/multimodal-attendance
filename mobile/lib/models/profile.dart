class Profile {
  final String id;
  final String fullName;
  final String role;
  final String? matricNumber;
  final String? deviceId;

  Profile({
    required this.id,
    required this.fullName,
    required this.role,
    this.matricNumber,
    this.deviceId,
  });

  factory Profile.fromJson(Map<String, dynamic> json) {
    return Profile(
      id: json['id'] as String,
      fullName: json['full_name'] as String,
      role: json['role'] as String,
      matricNumber: json['matric_number'] as String?,
      deviceId: json['device_id'] as String?,
    );
  }
}
