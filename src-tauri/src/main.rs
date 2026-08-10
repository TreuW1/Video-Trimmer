// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
#[cfg(windows)]
use std::os::windows::process::CommandExt;

use tauri::{command, Manager};
use tauri_plugin_fs::FsExt;
use std::process::{Command, Stdio, Child};
use std::path::PathBuf;
use std::sync::Mutex;
use std::fs::OpenOptions;
use tauri_plugin_prevent_default::{self as prevent_default, Flags, PlatformOptions};

const LIBRARY_VIDEO_EXTENSIONS: [&str; 8] = ["mp4", "avi", "mov", "mkv", "webm", "flv", "wmv", "m4v"];

fn validate_library_video_path(video_path: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(video_path);
    if !path.is_file() {
        return Err("The video file no longer exists".to_string());
    }

    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase())
        .ok_or_else(|| "The selected file is not a supported video".to_string())?;

    if !LIBRARY_VIDEO_EXTENSIONS.contains(&extension.as_str()) {
        return Err("The selected file is not a supported video".to_string());
    }

    Ok(path)
}

fn thumbnail_cache_name(video_path: &str) -> String {
    // Match the frontend's JavaScript hash (charCodeAt + signed 32-bit wrapping).
    let hash = video_path.encode_utf16().fold(0_i32, |hash, character| {
        hash.wrapping_mul(31).wrapping_add(i32::from(character))
    });
    format!("thumb_{}.jpg", i64::from(hash).abs())
}

fn migrate_cached_thumbnail(app: &tauri::AppHandle, old_path: &str, new_path: &str) {
    let Ok(local_data_dir) = app.path().local_data_dir() else {
        return;
    };
    let thumbnail_dir = local_data_dir.join("VideoTrimmer").join("video-thumbnails");
    let old_thumbnail = thumbnail_dir.join(thumbnail_cache_name(old_path));
    let new_thumbnail = thumbnail_dir.join(thumbnail_cache_name(new_path));

    if old_thumbnail == new_thumbnail || !old_thumbnail.is_file() {
        return;
    }

    if new_thumbnail.exists() {
        // The destination already has a cached image, so only remove the obsolete copy.
        let _ = std::fs::remove_file(old_thumbnail);
    } else if let Err(error) = std::fs::rename(old_thumbnail, new_thumbnail) {
        eprintln!("Could not migrate renamed video's thumbnail: {}", error);
    }
}

#[command]
async fn delete_library_video(video_path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = validate_library_video_path(&video_path)?;
        std::fs::remove_file(path).map_err(|error| format!("Could not delete video: {}", error))
    })
    .await
    .map_err(|error| format!("Delete task failed: {}", error))?
}

#[command]
async fn rename_library_video(app: tauri::AppHandle, video_path: String, new_name: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = validate_library_video_path(&video_path)?;
        let trimmed_name = new_name.trim();
        if trimmed_name.is_empty() {
            return Err("Enter a file name".to_string());
        }

        let candidate = PathBuf::from(trimmed_name);
        if candidate.file_name().and_then(|value| value.to_str()) != Some(trimmed_name) {
            return Err("The file name cannot contain a folder path".to_string());
        }

        let old_extension = path.extension().and_then(|value| value.to_str()).unwrap_or("");
        let new_extension = candidate.extension().and_then(|value| value.to_str()).unwrap_or("");
        if !old_extension.eq_ignore_ascii_case(new_extension) {
            return Err(format!("Keep the .{} video extension", old_extension));
        }

        let destination = path
            .parent()
            .ok_or_else(|| "Could not determine the video's folder".to_string())?
            .join(trimmed_name);
        if destination == path {
            return Ok(video_path);
        }
        if destination.exists() {
            return Err("A file with that name already exists".to_string());
        }

        std::fs::rename(&path, &destination)
            .map_err(|error| format!("Could not rename video: {}", error))?;
        let destination_string = destination.to_string_lossy().to_string();
        migrate_cached_thumbnail(&app, &video_path, &destination_string);
        Ok(destination_string)
    })
    .await
    .map_err(|error| format!("Rename task failed: {}", error))?
}

#[command]
async fn open_library_video_location(video_path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = validate_library_video_path(&video_path)?;

        #[cfg(target_os = "windows")]
        let mut command = {
            let mut command = Command::new("explorer.exe");
            command.arg(format!("/select,{}", path.to_string_lossy()));
            command
        };

        #[cfg(target_os = "macos")]
        let mut command = {
            let mut command = Command::new("open");
            command.arg("-R").arg(&path);
            command
        };

        #[cfg(all(unix, not(target_os = "macos")))]
        let mut command = {
            let mut command = Command::new("xdg-open");
            command.arg(path.parent().unwrap_or(&path));
            command
        };

        #[cfg(windows)]
        command.creation_flags(0x08000000);

        command
            .spawn()
            .map_err(|error| format!("Could not open file location: {}", error))?;
        Ok(())
    })
    .await
    .map_err(|error| format!("Open-location task failed: {}", error))?
}


#[tauri::command]
async fn generate_video_thumbnail(video_path: String, output_path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut cmd = Command::new("ffmpeg");

        cmd.args(&[
            "-hide_banner",
            "-loglevel", "error",
            // Input seeking avoids decoding everything before the thumbnail timestamp.
            "-ss", "00:00:01",
            "-i", &video_path,
            "-frames:v", "1",
            "-vf", "scale=720:-2",
            "-q:v", "5",
            "-y",
            &output_path,
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

        #[cfg(windows)]
        {
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }

        let output = cmd
            .output()
            .map_err(|e| format!("Failed to run ffmpeg: {}", e))?;

        if output.status.success() {
            Ok(output_path)
        } else {
            Err(format!(
                "FFmpeg error: {}",
                String::from_utf8_lossy(&output.stderr)
            ))
        }
    })
    .await
    .map_err(|e| format!("Thumbnail task failed: {}", e))?
}


#[command]
async fn get_video_duration(video_path: String) -> Result<f64, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut cmd = Command::new("ffprobe");

        cmd.args(&[
            "-v", "error",
            "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1",
            &video_path
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

        #[cfg(windows)]
        {
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }

        let output = cmd
            .output()
            .map_err(|e| format!("Failed to run ffprobe: {}", e))?;

        if output.status.success() {
            let duration_str = String::from_utf8_lossy(&output.stdout);
            let duration: f64 = duration_str.trim().parse()
                .map_err(|e| format!("Failed to parse duration: {}", e))?;
            Ok(duration)
        } else {
            Err(format!("FFprobe error: {}", String::from_utf8_lossy(&output.stderr)))
        }
    })
    .await
    .map_err(|e| format!("Duration task failed: {}", e))?
}

#[command]
fn read_video_file(video_path: String) -> Result<Vec<u8>, String> {
    use std::fs;
    // Read the video file and return as bytes
    fs::read(&video_path).map_err(|e| format!("Failed to read video file: {}", e))
}

fn find_node_executable(server_path: Option<&std::path::Path>) -> Option<String> {
    if let Some(server_path) = server_path {
        if let Some(server_dir) = server_path.parent() {
            let bundled_node = server_dir.join("node-runtime");
            if bundled_node.exists() {
                return Some(bundled_node.to_string_lossy().to_string());
            }
        }
    }

    // Try common Node.js executable names
    let node_names: Vec<&str> = if cfg!(windows) {
        vec!["node.exe", "node"]
    } else {
        vec!["node"]
    };

    for node_name in &node_names {
        if let Ok(output) = Command::new(node_name).arg("--version").output() {
            if output.status.success() {
                return Some(node_name.to_string());
            }
        }
    }

    // Try to find node in PATH
    if let Ok(path) = std::env::var("PATH") {
        for dir in path.split(if cfg!(windows) { ';' } else { ':' }) {
            for node_name in &node_names {
                let node_path = PathBuf::from(dir).join(node_name);
                if node_path.exists() {
                    return Some(node_path.to_string_lossy().to_string());
                }
            }
        }
    }

    None
}

fn start_backend_server(app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    // Try to get server.cjs path from resources (production build)
    // In Tauri v2, use resource_dir() and join the filename
    let server_path = match app.path().resource_dir() {
        Ok(resource_dir) => {
            let mut candidates = vec![
                resource_dir.join("backend-dist").join("server.cjs"),
                resource_dir.join("server.cjs"),
            ];

            if let Some(install_dir) = resource_dir.parent() {
                candidates.push(install_dir.join("backend-dist").join("server.cjs"));
                candidates.push(install_dir.join("_up_").join("server.cjs"));
            }

            if let Some(server_path) = candidates.into_iter().find(|path| path.exists()) {
                println!("Using bundled server.cjs: {}", server_path.display());
                server_path
            } else {
                get_dev_server_path(app)?
            }
        }
        _ => {
            // Fallback to dev path
            get_dev_server_path(app)?
        }
    };

    // Find Node.js executable
    let node_exe = find_node_executable(Some(&server_path))
        .ok_or("Node.js not found. Please install Node.js to run the backend server.")?;

    println!("Starting backend server: {} {}", node_exe, server_path.display());

    let app_data_dir = app.path().local_data_dir()
        .map_err(|_| "Could not determine local data directory")?
        .join("VideoTrimmer");
    std::fs::create_dir_all(&app_data_dir)?;

    let stdout_log = OpenOptions::new()
        .create(true)
        .append(true)
        .open(app_data_dir.join("backend.log"))?;
    let stderr_log = OpenOptions::new()
        .create(true)
        .append(true)
        .open(app_data_dir.join("backend.err.log"))?;

    // Start the Node.js process
    let mut cmd = Command::new(&node_exe);
    cmd.arg(&server_path)
        .env("VIDEO_TRIMMER_DATA_DIR", &app_data_dir)
        .stdout(Stdio::from(stdout_log))
        .stderr(Stdio::from(stderr_log))
        .stdin(Stdio::null());

    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    // Set working directory to server.cjs parent directory
    if let Some(parent) = server_path.parent() {
        cmd.current_dir(parent);
    }

    let child = cmd.spawn()
        .map_err(|e| format!("Failed to start backend server: {}", e))?;

    let pid = child.id();
    
    // Store the process handle in app state for cleanup
    if let Ok(mut child_guard) = app.state::<Mutex<Option<Child>>>().try_lock() {
        *child_guard = Some(child);
    } else {
        return Err("Failed to access backend process state".into());
    }

    println!("Backend server started successfully (PID: {})", pid);

    Ok(())
}

fn get_dev_server_path(app: &tauri::AppHandle) -> Result<PathBuf, Box<dyn std::error::Error>> {
    // Try to get app data dir and navigate to project root
    let app_data_dir = app.path().local_data_dir()
        .map_err(|_| "Could not determine local data directory")?
        .join("VideoTrimmer");
    
    // In dev: app_data_dir is typically src-tauri/target/.../app_data
    // We need to go up to project root
    let mut dev_path = app_data_dir.clone();
    // Go up from app_data to target to src-tauri to project root
    for _ in 0..4 {
        if let Some(parent) = dev_path.parent() {
            dev_path = parent.to_path_buf();
        } else {
            break;
        }
    }
    dev_path = dev_path.join("server.cjs");
    
    if dev_path.exists() {
        println!("Using server.cjs from project root: {}", dev_path.display());
        return Ok(dev_path);
    }
    
    // Try alternative path resolution - check current executable's directory
    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            let mut check_path = exe_dir.to_path_buf();
            // Go up a few levels to find project root
            for _ in 0..5 {
                let test_path = check_path.join("server.cjs");
                if test_path.exists() {
                    println!("Using server.cjs from: {}", test_path.display());
                    return Ok(test_path);
                }
                if let Some(parent) = check_path.parent() {
                    check_path = parent.to_path_buf();
                } else {
                    break;
                }
            }
        }
    }
    
    // Try current directory
    let alt_path = PathBuf::from("server.cjs");
    if alt_path.exists() {
        println!("Using server.cjs from current directory: {}", alt_path.display());
        return Ok(alt_path);
    }
    
    Err(format!(
        "server.cjs not found. Tried: {}, {}",
        dev_path.display(),
        alt_path.display()
    ).into())
}


fn main() {
    let prevent_plugin = prevent_default::Builder::new()
        .with_flags(Flags::all())
        .platform(
            PlatformOptions::new()
                .browser_accelerator_keys(false)
                .default_context_menus(false)
                .default_script_dialogs(false)
        )
        .build();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(prevent_plugin)
        .setup(|app| {
            // Register additional asset protocol scope for video files
            let asset_protocol = app.asset_protocol_scope();
            asset_protocol.allow_directory("C:\\", true)?;
            asset_protocol.allow_directory("/", true)?;

            // Configure fs plugin scope...
            let fs_scope = app.fs_scope();
            fs_scope.allow_directory("C:\\", true)?;
            fs_scope.allow_directory("/", true)?;

            // Initialize backend process state
            app.manage(std::sync::Mutex::<Option<std::process::Child>>::new(None));
            
            // Starting the bundled Node runtime can take a few seconds on Windows
            // (especially while antivirus scans the executable). Keep that work off
            // the UI startup thread so the webview can load and paint immediately.
            let backend_app_handle = app.handle().clone();
            tauri::async_runtime::spawn_blocking(move || {
                if let Err(e) = start_backend_server(&backend_app_handle) {
                    eprintln!("Warning: Failed to start backend server: {}", e);
                    eprintln!("The application will continue, but backend features may not work.");
                }
            });
            
            // Cleanup handler: kill backend process on app exit
            let app_handle = app.handle().clone();
            if let Some(window) = app.get_webview_window("main") {
                window.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { .. } = event {
                        if let Ok(mut child_guard) = app_handle.state::<std::sync::Mutex<Option<std::process::Child>>>().try_lock() {
                            if let Some(child) = child_guard.take() {
                                println!("Shutting down backend server (PID: {})...", child.id());
                                #[cfg(windows)]
                                {
                                    let _ = std::process::Command::new("taskkill")
                                        .args(&["/F", "/T", "/PID", &child.id().to_string()])
                                        .output();
                                }
                                #[cfg(not(windows))]
                                {
                                    let _ = child.kill();
                                }
                            }
                        }
                    }
                });
            }

            // Optional: Force initial focus
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
            }

            Ok(())  
        })
        .invoke_handler(tauri::generate_handler![
            generate_video_thumbnail,
            get_video_duration,
            read_video_file,
            delete_library_video,
            rename_library_video,
            open_library_video_location
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
