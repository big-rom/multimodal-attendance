import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:mobile_scanner/mobile_scanner.dart';
import 'package:supabase_flutter/supabase_flutter.dart';
import 'package:geolocator/geolocator.dart';
import 'package:permission_handler/permission_handler.dart';
import '../../core/supabase_client.dart';
import 'shell.dart';

class ScanTab extends StatefulWidget {
  const ScanTab({super.key});

  @override
  State<ScanTab> createState() => _ScanTabState();
}

class _ScanTabState extends State<ScanTab> with WidgetsBindingObserver {
  bool _isLoading = true;
  bool _hasActiveSession = false;
  bool _forceOpenScanner = false;
  bool _isCheckingPermissions = false;
  bool _hasCameraPermission = false;
  bool _isProcessing = false;
  bool _showSuccess = false;
  bool _showError = false;
  String _errorText = "";
  String? _scannedSessionId;

  MobileScannerController? _scannerController;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _checkActiveSessions();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _scannerController?.dispose();
    _scannerController = null;
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    final controller = _scannerController;
    if (controller == null || !controller.value.isInitialized) {
      return;
    }

    switch (state) {
      case AppLifecycleState.detached:
      case AppLifecycleState.hidden:
      case AppLifecycleState.paused:
      case AppLifecycleState.inactive:
        if (controller.value.isRunning) {
          controller.stop();
        }
        break;
      case AppLifecycleState.resumed:
        if (!controller.value.isRunning) {
          controller.start();
        }
        break;
    }
  }

  Future<void> _checkActiveSessions() async {
    if (!mounted) return;
    setState(() {
      _isLoading = true;
      _forceOpenScanner = false;
    });

    try {
      final userId = SupabaseCore.client.auth.currentUser?.id;
      if (userId == null) {
        if (mounted) setState(() => _isLoading = false);
        return;
      }

      // 1. Get enrolled course IDs
      final enrollments = await SupabaseCore.client
          .from('course_enrollments')
          .select('course_id')
          .eq('student_id', userId)
          .eq('status', 'approved');

      final courseIds = (enrollments as List).map((e) => e['course_id']).toList();

      if (courseIds.isEmpty) {
        if (mounted) {
          setState(() {
            _hasActiveSession = false;
            _isLoading = false;
          });
        }
        return;
      }

      // 2. Check if any session is currently active for enrolled courses
      final activeSessions = await SupabaseCore.client
          .from('sessions')
          .select('id')
          .inFilter('course_id', courseIds)
          .isFilter('ends_at', null)
          .limit(1);

      final hasSession = (activeSessions as List).isNotEmpty;

      if (mounted) {
        setState(() {
          _hasActiveSession = hasSession;
          _isLoading = false;
        });

        if (hasSession) {
          _requestPermissionsAndStartCamera();
        }
      }
    } catch (_) {
      if (mounted) {
        setState(() {
          _hasActiveSession = false;
          _isLoading = false;
        });
      }
    }
  }

  Position? _currentPosition;

  void _warmupLocation() async {
    try {
      final serviceEnabled = await Geolocator.isLocationServiceEnabled();
      if (!serviceEnabled) return;

      final lastPos = await Geolocator.getLastKnownPosition();
      if (lastPos != null && DateTime.now().difference(lastPos.timestamp).inMinutes < 5) {
        _currentPosition = lastPos;
      }

      final freshPos = await Geolocator.getCurrentPosition(
        locationSettings: const LocationSettings(
          accuracy: LocationAccuracy.high,
          timeLimit: Duration(seconds: 5),
        ),
      );
      _currentPosition = freshPos;
    } catch (_) {}
  }

  Future<void> _requestPermissionsAndStartCamera() async {
    if (_isCheckingPermissions) return;
    _isCheckingPermissions = true;

    try {
      // Prompt for both Camera and Location runtime permissions
      final statuses = await [
        Permission.camera,
        Permission.location,
      ].request();

      final cameraGranted = statuses[Permission.camera]?.isGranted ?? false;

      if (!mounted) return;

      setState(() {
        _hasCameraPermission = cameraGranted;
      });

      if (cameraGranted) {
        _warmupLocation();
        if (_scannerController == null) {
          _scannerController = MobileScannerController(
            detectionSpeed: DetectionSpeed.noDuplicates,
            facing: CameraFacing.back,
            returnImage: false,
          );
          if (mounted) setState(() {});
        }
      }
    } finally {
      _isCheckingPermissions = false;
    }
  }

  Future<void> _processQRCode(String rawData) async {
    if (_isProcessing) return;
    setState(() => _isProcessing = true);

    try {
      final raw = rawData.trim();
      Map<String, dynamic> payload;

      // 1. Decode Base64 or parse directly as JSON
      try {
        final decodedString = utf8.decode(base64.decode(raw));
        payload = jsonDecode(decodedString) as Map<String, dynamic>;
      } catch (_) {
        payload = jsonDecode(raw) as Map<String, dynamic>;
      }

      final sessionId = payload['session_id'];
      final timestamp = payload['timestamp'];
      final signature = payload['signature'];

      if (sessionId == null || timestamp == null || signature == null) {
        throw const FormatException("Invalid QR Code payload format.");
      }

      // Prevent immediate rescan of the exact same session
      if (_scannedSessionId == sessionId) {
        setState(() => _isProcessing = false);
        return;
      }

      final userId = SupabaseCore.client.auth.currentUser?.id;
      if (userId == null) {
        throw Exception("You must be logged in to mark attendance.");
      }

      // Use pre-warmed GPS position or quick fallback
      Position? position = _currentPosition;
      if (position == null || DateTime.now().difference(position.timestamp).inMinutes > 5) {
        try {
          final serviceEnabled = await Geolocator.isLocationServiceEnabled();
          if (serviceEnabled) {
            final lastPos = await Geolocator.getLastKnownPosition();
            if (lastPos != null && DateTime.now().difference(lastPos.timestamp).inMinutes < 2) {
              position = lastPos;
            } else {
              position = await Geolocator.getCurrentPosition(
                locationSettings: const LocationSettings(
                  accuracy: LocationAccuracy.medium,
                  timeLimit: Duration(seconds: 2),
                ),
              );
              _currentPosition = position;
            }
          }
        } catch (_) {}
      }

      // 2. Call verify-qr Edge Function
      final response = await SupabaseCore.client.functions.invoke(
        'verify-qr',
        body: {
          'session_id': sessionId,
          'timestamp': timestamp,
          'signature': signature,
          'student_id': userId,
          'method': 'qr',
          if (position != null) 'latitude': position.latitude,
          if (position != null) 'longitude': position.longitude,
        },
      );

      // Handle response mapping
      if (response.status == 201) {
        _scannedSessionId = sessionId; // remember success to prevent rescan

        if (mounted) {
          setState(() {
            _isProcessing = false;
            _showSuccess = true;
          });

          await Future.delayed(const Duration(milliseconds: 1600));

          if (mounted) {
            Navigator.of(context).pushReplacement(
              MaterialPageRoute(builder: (context) => const ShellScreen()),
            );
          }
        }
      } else {
        final errObj = response.data;
        String errMsg = 'Verification failed (${response.status})';
        if (errObj is Map) {
          errMsg = errObj['error'] ?? errObj['message'] ?? errMsg;
        }
        throw FunctionException(status: response.status, details: errMsg);
      }
    } on FunctionException catch (e) {
      if (!mounted) return;

      String errorMessage = 'An error occurred. Please try again.';

      if (e.status == 409) {
        errorMessage = 'Already marked present.';
      } else if (e.status == 401) {
        errorMessage = 'QR code has expired. Ask your lecturer to regenerate.';
      } else if (e.status == 403) {
        final detailsStr = e.details?.toString() ?? '';
        if (detailsStr.contains('enrolment-pending')) {
          errorMessage = 'Your request is still waiting for approval';
        } else if (detailsStr.isNotEmpty) {
          errorMessage = detailsStr;
        } else {
          errorMessage = 'You must be approved for this course to mark attendance.';
        }
      } else if (e.status == 400) {
        errorMessage = 'Invalid QR code format.';
      } else if (e.details != null && e.details.toString().isNotEmpty) {
        errorMessage = e.details.toString();
      }

      if (mounted) {
        setState(() {
          _isProcessing = false;
          _showError = true;
          _errorText = errorMessage;
        });
      }

      await Future.delayed(const Duration(milliseconds: 2500));
      if (mounted) setState(() => _showError = false);
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _isProcessing = false;
        _showError = true;
        _errorText = e.toString().replaceFirst('Exception: ', '').replaceFirst('FormatException: ', '');
      });
      await Future.delayed(const Duration(milliseconds: 2500));
      if (mounted) setState(() => _showError = false);
    } finally {
      if (mounted && !_showSuccess && !_showError) {
        setState(() => _isProcessing = false);
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_isLoading) {
      return Scaffold(
        appBar: AppBar(title: const Text('Scan QR')),
        body: const Center(child: CircularProgressIndicator()),
      );
    }

    // State 1: No active session detected
    if (!_hasActiveSession && !_forceOpenScanner) {
      return Scaffold(
        appBar: AppBar(
          title: const Text('Scan QR'),
        ),
        body: Center(
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 32),
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                Icon(Icons.event_busy, size: 80, color: Colors.grey[400]),
                const SizedBox(height: 16),
                const Text(
                  'No active session right now',
                  style: TextStyle(
                    fontSize: 20,
                    fontWeight: FontWeight.bold,
                    color: Colors.grey,
                  ),
                  textAlign: TextAlign.center,
                ),
                const SizedBox(height: 8),
                const Text(
                  'Wait for your lecturer to start an attendance session in your course.',
                  style: TextStyle(color: Colors.grey),
                  textAlign: TextAlign.center,
                ),
                const SizedBox(height: 24),
                ElevatedButton.icon(
                  onPressed: _checkActiveSessions,
                  icon: const Icon(Icons.refresh),
                  label: const Text('Refresh'),
                ),
                const SizedBox(height: 12),
                TextButton.icon(
                  onPressed: () {
                    setState(() => _forceOpenScanner = true);
                    _requestPermissionsAndStartCamera();
                  },
                  icon: const Icon(Icons.camera_alt_outlined, size: 18),
                  label: const Text('Open Camera Anyway'),
                  style: TextButton.styleFrom(
                    foregroundColor: Colors.grey[600],
                  ),
                ),
              ],
            ),
          ),
        ),
      );
    }

    // State 2: Camera permission needed
    if (!_hasCameraPermission) {
      return Scaffold(
        appBar: AppBar(
          title: const Text('Scan QR'),
        ),
        body: Center(
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 32),
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                Icon(Icons.no_photography_outlined, size: 80, color: Colors.grey[400]),
                const SizedBox(height: 16),
                const Text(
                  'Camera & Location Access Needed',
                  style: TextStyle(
                    fontSize: 20,
                    fontWeight: FontWeight.bold,
                    color: Colors.grey,
                  ),
                  textAlign: TextAlign.center,
                ),
                const SizedBox(height: 8),
                const Text(
                  'Camera access is required to scan attendance QR codes, and location access verifies attendance at the venue.',
                  style: TextStyle(color: Colors.grey),
                  textAlign: TextAlign.center,
                ),
                const SizedBox(height: 24),
                ElevatedButton.icon(
                  onPressed: () async {
                    final status = await Permission.camera.status;
                    if (status.isPermanentlyDenied) {
                      await openAppSettings();
                    } else {
                      await _requestPermissionsAndStartCamera();
                    }
                  },
                  icon: const Icon(Icons.lock_open),
                  label: const Text('Grant Access'),
                ),
                const SizedBox(height: 12),
                TextButton(
                  onPressed: () {
                    setState(() {
                      _forceOpenScanner = false;
                      _checkActiveSessions();
                    });
                  },
                  child: const Text('Back to Session Status'),
                ),
              ],
            ),
          ),
        ),
      );
    }

    // State 3: Live Scanner View
    return Scaffold(
      appBar: AppBar(
        title: const Text('Scan QR'),
        backgroundColor: Colors.transparent,
        actions: [
          IconButton(
            icon: const Icon(Icons.flash_on),
            tooltip: 'Toggle Flash',
            onPressed: () => _scannerController?.toggleTorch(),
          ),
          IconButton(
            icon: const Icon(Icons.flip_camera_ios),
            tooltip: 'Switch Camera',
            onPressed: () => _scannerController?.switchCamera(),
          ),
        ],
      ),
      body: Stack(
        children: [
          if (_scannerController != null)
            MobileScanner(
              controller: _scannerController!,
              errorBuilder: (context, error, child) {
                return Container(
                  color: Colors.black,
                  padding: const EdgeInsets.all(24),
                  child: Center(
                    child: Column(
                      mainAxisAlignment: MainAxisAlignment.center,
                      children: [
                        const Icon(Icons.error_outline, size: 64, color: Colors.white70),
                        const SizedBox(height: 16),
                        Text(
                          'Camera error: ${error.errorDetails?.message ?? error.errorCode.name}',
                          textAlign: TextAlign.center,
                          style: const TextStyle(color: Colors.white, fontSize: 16),
                        ),
                        const SizedBox(height: 24),
                        ElevatedButton.icon(
                          onPressed: () => _scannerController?.start(),
                          icon: const Icon(Icons.refresh),
                          label: const Text('Retry Camera'),
                          style: ElevatedButton.styleFrom(
                            backgroundColor: Colors.indigo,
                            foregroundColor: Colors.white,
                            padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 12),
                          ),
                        ),
                      ],
                    ),
                  ),
                );
              },
              onDetect: (capture) {
                final List<Barcode> barcodes = capture.barcodes;
                for (final barcode in barcodes) {
                  if (barcode.rawValue != null && barcode.rawValue!.isNotEmpty) {
                    _processQRCode(barcode.rawValue!);
                    break;
                  }
                }
              },
            ),

          // Target Reticle
          Center(
            child: Container(
              width: 250,
              height: 250,
              decoration: BoxDecoration(
                border: Border.all(color: Colors.white.withAlpha(160), width: 2),
                borderRadius: BorderRadius.circular(16),
              ),
            ),
          ),

          const Positioned(
            bottom: 60,
            left: 0,
            right: 0,
            child: Text(
              'Align the QR code within the frame to scan',
              textAlign: TextAlign.center,
              style: TextStyle(
                color: Colors.white,
                fontSize: 16,
                fontWeight: FontWeight.bold,
                shadows: [Shadow(color: Colors.black, blurRadius: 4)],
              ),
            ),
          ),

          // Processing overlay
          if (_isProcessing)
            Container(
              color: Colors.black.withAlpha(140),
              child: const Center(
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    CircularProgressIndicator(color: Colors.white),
                    SizedBox(height: 16),
                    Text(
                      'Recording attendance…',
                      style: TextStyle(color: Colors.white, fontSize: 16, fontWeight: FontWeight.w500),
                    ),
                  ],
                ),
              ),
            ),

          // Success overlay
          if (_showSuccess)
            Container(
              color: Colors.black.withAlpha(210),
              child: Center(
                child: TweenAnimationBuilder<double>(
                  tween: Tween(begin: 0.5, end: 1.0),
                  duration: const Duration(milliseconds: 400),
                  curve: Curves.elasticOut,
                  builder: (context, scale, child) {
                    return Transform.scale(
                      scale: scale,
                      child: Column(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Container(
                            padding: const EdgeInsets.all(20),
                            decoration: const BoxDecoration(
                              color: Colors.green,
                              shape: BoxShape.circle,
                            ),
                            child: const Icon(Icons.check, size: 80, color: Colors.white),
                          ),
                          const SizedBox(height: 20),
                          const Text(
                            'Success!',
                            style: TextStyle(color: Colors.white, fontSize: 28, fontWeight: FontWeight.bold),
                          ),
                        ],
                      ),
                    );
                  },
                ),
              ),
            ),

          // Error overlay
          if (_showError)
            Container(
              color: Colors.black.withAlpha(210),
              child: Center(
                child: TweenAnimationBuilder<double>(
                  tween: Tween(begin: 0.8, end: 1.0),
                  duration: const Duration(milliseconds: 300),
                  curve: Curves.easeOutBack,
                  builder: (context, scale, child) {
                    return Transform.scale(
                      scale: scale,
                      child: Padding(
                        padding: const EdgeInsets.symmetric(horizontal: 40),
                        child: Column(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            Container(
                              padding: const EdgeInsets.all(20),
                              decoration: const BoxDecoration(
                                color: Colors.redAccent,
                                shape: BoxShape.circle,
                              ),
                              child: const Icon(Icons.close, size: 60, color: Colors.white),
                            ),
                            const SizedBox(height: 20),
                            Text(
                              _errorText,
                              textAlign: TextAlign.center,
                              style: const TextStyle(color: Colors.white, fontSize: 16, fontWeight: FontWeight.w500),
                            ),
                          ],
                        ),
                      ),
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
