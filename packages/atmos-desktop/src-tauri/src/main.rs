#![cfg_attr(
  all(not(debug_assertions), target_os = "windows"),
  windows_subsystem = "windows"
)]

use tauri::{
    AppHandle, CustomMenuItem, Manager, SystemTray, SystemTrayEvent, SystemTrayMenu,
    SystemTrayMenuItem,
};
use std::process::{Child, Command};
use std::sync::{Arc, Mutex};
use std::thread;

/// Struct tracking the active Atmos API Shim proxy process
struct ProxyState {
    child_process: Option<Child>,
}

type SharedProxyState = Arc<Mutex<ProxyState>>;

fn main() {
    // 1. Initialize system tray menu items
    let start_proxy = CustomMenuItem::new("start_proxy".to_string(), "Start Atmos Proxy");
    let stop_proxy = CustomMenuItem::new("stop_proxy".to_string(), "Stop Atmos Proxy").disabled();
    let check_status = CustomMenuItem::new("check_status".to_string(), "Check P2P Network Status");
    let exit = CustomMenuItem::new("exit".to_string(), "Exit");

    // 2. Build the System Tray Menu
    let tray_menu = SystemTrayMenu::new()
        .add_item(start_proxy)
        .add_item(stop_proxy)
        .add_native_item(SystemTrayMenuItem::Separator)
        .add_item(check_status)
        .add_native_item(SystemTrayMenuItem::Separator)
        .add_item(exit);

    let system_tray = SystemTray::new().with_menu(tray_menu);

    // 3. Initialize Shared State to manage the spawned proxy child process safely across threads
    let proxy_state: SharedProxyState = Arc::new(Mutex::new(ProxyState { child_process: None }));

    // 4. Build and run the Tauri application
    tauri::Builder::default()
        .manage(proxy_state.clone())
        .system_tray(system_tray)
        .on_system_tray_event(move |app, event| {
            if let SystemTrayEvent::MenuItemClick { id, .. } = event {
                let state = app.state::<SharedProxyState>();
                match id.as_str() {
                    "start_proxy" => {
                        handle_start_proxy(app, &state);
                    }
                    "stop_proxy" => {
                        handle_stop_proxy(app, &state);
                    }
                    "check_status" => {
                        handle_check_status(app);
                    }
                    "exit" => {
                        handle_exit(app, &state);
                    }
                    _ => {}
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|_app_handle, event| match event {
            tauri::RunEvent::ExitRequested { api, .. } => {
                // Intercept general exit requests to keep the tray app running silently
                api.prevent_exit();
            }
            _ => {}
        });
}

/// Spawns the Atmos API Shim process cleanly in Rust
fn handle_start_proxy(app: &AppHandle, state: &SharedProxyState) {
    let mut state_lock = state.lock().expect("Failed to lock proxy state");
    if state_lock.child_process.is_none() {
        println!("[Atmos Desktop] Starting Atmos Proxy process...");

        // Setup Command based on OS environment
        #[cfg(target_os = "windows")]
        let (cmd, args) = ("cmd", ["/C", "npm run start:shim"]);
        #[cfg(not(target_os = "windows"))]
        let (cmd, args) = ("npm", ["run", "start:shim"]);

        // Resolve workspace monorepo root dynamically to ensure API shim is run correctly
        let mut working_dir = std::env::current_dir().unwrap_or_default();
        let mut found = false;
        
        // Crawl upwards up to 5 directories to locate the core monorepo root package structure
        for _ in 0..5 {
            if working_dir.join("package.json").exists() && working_dir.join("packages").exists() {
                found = true;
                break;
            }
            if let Some(parent) = working_dir.parent() {
                working_dir = parent.to_path_buf();
            } else {
                break;
            }
        }

        if found {
            println!("[Atmos Desktop] Dynamic root resolution succeeded: {:?}", working_dir);
        } else {
            println!("[Atmos Desktop] Warning: Monorepo root could not be located. Defaulting to current dir.");
            working_dir = std::env::current_dir().unwrap_or_default();
        }

        match Command::new(cmd)
            .args(&args)
            .current_dir(&working_dir)
            .spawn()
        {
            Ok(child) => {
                state_lock.child_process = Some(child);
                println!("[Atmos Desktop] Atmos API Shim spawned successfully.");

                // Adjust system tray options dynamically
                let _ = app.tray_handle().get_item("start_proxy").set_enabled(false);
                let _ = app.tray_handle().get_item("stop_proxy").set_enabled(true);

                // Send desktop notification
                let _ = tauri::api::notification::Notification::new("com.atmos.desktop")
                    .title("Atmos API Proxy")
                    .body("The P2P interceptor proxy has been successfully started.")
                    .show(app);
            }
            Err(err) => {
                eprintln!("[Atmos Desktop] Failed to spawn Atmos API Shim child: {:?}", err);
                let _ = tauri::api::notification::Notification::new("com.atmos.desktop")
                    .title("Atmos API Proxy Error")
                    .body(format!("Failed to start proxy: {}", err))
                    .show(app);
            }
        }
    } else {
        println!("[Atmos Desktop] Atmos Proxy is already running.");
    }
}

/// Terminates the Atmos API Shim process cleanly in Rust
fn handle_stop_proxy(app: &AppHandle, state: &SharedProxyState) {
    let mut state_lock = state.lock().expect("Failed to lock proxy state");
    if let Some(mut child) = state_lock.child_process.take() {
        println!("[Atmos Desktop] Terminating Atmos Proxy child process...");
        match child.kill() {
            Ok(_) => {
                let _ = child.wait(); // Reclaim OS process resource
                println!("[Atmos Desktop] Atmos API Shim child process terminated.");
                
                let _ = app.tray_handle().get_item("start_proxy").set_enabled(true);
                let _ = app.tray_handle().get_item("stop_proxy").set_enabled(false);

                let _ = tauri::api::notification::Notification::new("com.atmos.desktop")
                    .title("Atmos API Proxy")
                    .body("The P2P interceptor proxy has been stopped.")
                    .show(app);
            }
            Err(err) => {
                eprintln!("[Atmos Desktop] Failed to terminate child process: {:?}", err);
            }
        }
    } else {
        println!("[Atmos Desktop] Atmos Proxy is not running.");
    }
}

/// Checks the P2P network health status via the proxy's health endpoint using ureq crate
fn handle_check_status(app: &AppHandle) {
    println!("[Atmos Desktop] Checking P2P network health status...");
    let app_clone = app.clone();
    
    // Spawn network check in background to prevent blocking UI main thread
    thread::spawn(move || {
        match ureq::get("http://127.0.0.1:4000/health")
            .timeout(std::time::Duration::from_secs(3))
            .call()
        {
            Ok(response) => {
                if let Ok(body) = response.into_string() {
                    println!("[Atmos Desktop] P2P Status Health Payload: {}", body);
                    let _ = tauri::api::notification::Notification::new("com.atmos.desktop")
                        .title("Atmos Network Status: Healthy")
                        .body("Atmos P2P Proxy is online and routing peer requests.")
                        .show(&app_clone);
                }
            }
            Err(err) => {
                eprintln!("[Atmos Desktop] P2P Proxy health endpoint unreachable: {:?}", err);
                let _ = tauri::api::notification::Notification::new("com.atmos.desktop")
                    .title("Atmos Network Status: Offline")
                    .body("Could not connect to local P2P Proxy. Is it started?")
                    .show(&app_clone);
            }
        }
    });
}

/// Performs complete cleanup of spawned processes before exiting the application
fn handle_exit(app: &AppHandle, state: &SharedProxyState) {
    println!("[Atmos Desktop] Shutting down application and terminating all child processes...");
    let mut state_lock = state.lock().expect("Failed to lock proxy state before exit");
    if let Some(mut child) = state_lock.child_process.take() {
        let _ = child.kill();
        let _ = child.wait();
        println!("[Atmos Desktop] Cleanup completed.");
    }
    app.exit(0);
}
