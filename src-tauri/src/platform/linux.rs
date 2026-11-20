//! Linux video surface.
//!
//! mpv's `wid` embedding hands it an X11 window to draw into. That window is
//! a native child of the main window and always stacks above the webview, so
//! the player chrome was hidden behind the video, and Wayland has no foreign
//! window embedding at all. Instead, mpv renders through the libmpv render
//! API into a `GtkGLArea` that sits *under* the transparent webview inside a
//! `GtkOverlay`. GTK composites both layers itself, which works the same on
//! X11 and on native Wayland.

use std::cell::RefCell;
use std::ffi::{c_void, CStr, CString};
use std::os::raw::{c_char, c_int};
use std::ptr;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{mpsc, OnceLock};
use std::time::Duration;

use gtk::prelude::*;
use libmpv_sys::{
    mpv_error_string, mpv_handle, mpv_opengl_fbo, mpv_opengl_init_params, mpv_render_context,
    mpv_render_context_create, mpv_render_context_free, mpv_render_context_render,
    mpv_render_context_set_update_callback, mpv_render_context_update, mpv_render_param,
    mpv_render_param_type_MPV_RENDER_PARAM_API_TYPE, mpv_render_param_type_MPV_RENDER_PARAM_FLIP_Y,
    mpv_render_param_type_MPV_RENDER_PARAM_INVALID,
    mpv_render_param_type_MPV_RENDER_PARAM_OPENGL_FBO,
    mpv_render_param_type_MPV_RENDER_PARAM_OPENGL_INIT_PARAMS, MPV_RENDER_API_TYPE_OPENGL,
};
use tauri::{AppHandle, Manager};

const GL_FRAMEBUFFER_BINDING: u32 = 0x8CA6;
const GL_COLOR_BUFFER_BIT: u32 = 0x4000;
const MAIN_THREAD_TIMEOUT: Duration = Duration::from_secs(10);

thread_local! {
    /// The video layer. GTK widgets are main-thread only, so it lives here.
    static AREA: RefCell<Option<gtk::GLArea>> = const { RefCell::new(None) };
}

/// `*mut mpv_render_context`, or 0. Only the main thread renders or frees it.
static CONTEXT: AtomicUsize = AtomicUsize::new(0);
/// Whether GTK's GL context is EGL (Wayland, some X11 setups) or GLX.
static USES_EGL: AtomicBool = AtomicBool::new(false);

type GetProcAddress = unsafe extern "C" fn(*const c_char) -> *mut c_void;

struct Loaders {
    egl: Option<GetProcAddress>,
    glx: Option<GetProcAddress>,
    egl_current_context: Option<unsafe extern "C" fn() -> *mut c_void>,
}

fn loaders() -> &'static Loaders {
    static LOADERS: OnceLock<Loaders> = OnceLock::new();
    LOADERS.get_or_init(|| unsafe {
        let symbol = |lib: &CStr, name: &CStr| -> *mut c_void {
            let handle = libc::dlopen(lib.as_ptr(), libc::RTLD_LAZY | libc::RTLD_GLOBAL);
            if handle.is_null() {
                return ptr::null_mut();
            }
            libc::dlsym(handle, name.as_ptr())
        };
        let egl = symbol(c"libEGL.so.1", c"eglGetProcAddress");
        let glx = symbol(c"libGL.so.1", c"glXGetProcAddressARB");
        let current = symbol(c"libEGL.so.1", c"eglGetCurrentContext");
        Loaders {
            egl: (!egl.is_null()).then(|| std::mem::transmute::<*mut c_void, GetProcAddress>(egl)),
            glx: (!glx.is_null()).then(|| std::mem::transmute::<*mut c_void, GetProcAddress>(glx)),
            egl_current_context: (!current.is_null()).then(|| {
                std::mem::transmute::<*mut c_void, unsafe extern "C" fn() -> *mut c_void>(current)
            }),
        }
    })
}

/// Must run with GTK's GL context current.
fn detect_api() {
    let loaders = loaders();
    let egl = loaders
        .egl_current_context
        .is_some_and(|current| !unsafe { current() }.is_null());
    USES_EGL.store(egl, Ordering::SeqCst);
}

fn proc_address(name: &CStr) -> *mut c_void {
    let loaders = loaders();
    let loader = if USES_EGL.load(Ordering::SeqCst) {
        loaders.egl.or(loaders.glx)
    } else {
        loaders.glx.or(loaders.egl)
    };
    loader.map_or(ptr::null_mut(), |load| unsafe { load(name.as_ptr()) })
}

unsafe extern "C" fn get_proc_address(_ctx: *mut c_void, name: *const c_char) -> *mut c_void {
    if name.is_null() {
        return ptr::null_mut();
    }
    proc_address(CStr::from_ptr(name))
}

struct Gl {
    get_integerv: unsafe extern "C" fn(u32, *mut c_int),
    clear_color: unsafe extern "C" fn(f32, f32, f32, f32),
    clear: unsafe extern "C" fn(u32),
}

fn gl() -> Option<&'static Gl> {
    static GL: OnceLock<Option<Gl>> = OnceLock::new();
    GL.get_or_init(|| unsafe {
        let get_integerv = proc_address(c"glGetIntegerv");
        let clear_color = proc_address(c"glClearColor");
        let clear = proc_address(c"glClear");
        if get_integerv.is_null() || clear_color.is_null() || clear.is_null() {
            return None;
        }
        Some(Gl {
            get_integerv: std::mem::transmute::<*mut c_void, unsafe extern "C" fn(u32, *mut c_int)>(
                get_integerv,
            ),
            clear_color: std::mem::transmute::<
                *mut c_void,
                unsafe extern "C" fn(f32, f32, f32, f32),
            >(clear_color),
            clear: std::mem::transmute::<*mut c_void, unsafe extern "C" fn(u32)>(clear),
        })
    })
    .as_ref()
}

/// Called by mpv on its own threads whenever a new frame is ready.
unsafe extern "C" fn on_render_update(_ctx: *mut c_void) {
    gtk::glib::MainContext::default().invoke(|| {
        AREA.with(|area| {
            if let Some(area) = area.borrow().as_ref() {
                area.queue_render();
            }
        });
    });
}

fn render(area: &gtk::GLArea) {
    let Some(gl) = gl() else { return };
    let context = CONTEXT.load(Ordering::SeqCst) as *mut mpv_render_context;
    unsafe {
        if context.is_null() {
            (gl.clear_color)(0.0, 0.0, 0.0, 1.0);
            (gl.clear)(GL_COLOR_BUFFER_BIT);
            return;
        }
        let scale = area.scale_factor();
        let mut framebuffer: c_int = 0;
        (gl.get_integerv)(GL_FRAMEBUFFER_BINDING, &mut framebuffer);
        let mut fbo = mpv_opengl_fbo {
            fbo: framebuffer,
            w: area.allocated_width() * scale,
            h: area.allocated_height() * scale,
            internal_format: 0,
        };
        let mut flip_y: c_int = 1;
        let mut params = [
            mpv_render_param {
                type_: mpv_render_param_type_MPV_RENDER_PARAM_OPENGL_FBO,
                data: &mut fbo as *mut _ as *mut c_void,
            },
            mpv_render_param {
                type_: mpv_render_param_type_MPV_RENDER_PARAM_FLIP_Y,
                data: &mut flip_y as *mut _ as *mut c_void,
            },
            mpv_render_param {
                type_: mpv_render_param_type_MPV_RENDER_PARAM_INVALID,
                data: ptr::null_mut(),
            },
        ];
        mpv_render_context_update(context);
        mpv_render_context_render(context, params.as_mut_ptr());
    }
}

fn find_webview(container: &gtk::Container) -> Option<gtk::Widget> {
    for child in container.children() {
        if child.type_().name() == "WebKitWebView" {
            return Some(child);
        }
        if let Some(inner) = child.downcast_ref::<gtk::Container>() {
            if let Some(found) = find_webview(inner) {
                return Some(found);
            }
        }
    }
    None
}

/// Put a video layer under the webview. Runs once, on the main thread, from
/// the app's setup hook.
pub fn prepare_main_window(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let vbox = match window.default_vbox() {
        Ok(vbox) => vbox,
        Err(error) => {
            log::warn!("no GTK container for the video layer: {error}");
            return;
        }
    };
    let Some(webview) = find_webview(vbox.upcast_ref()) else {
        log::warn!("webview widget not found; video layer not installed");
        return;
    };
    let Some(parent) = webview
        .parent()
        .and_then(|parent| parent.downcast::<gtk::Container>().ok())
    else {
        return;
    };

    let area = gtk::GLArea::new();
    area.set_has_alpha(false);
    area.set_hexpand(true);
    area.set_vexpand(true);
    area.connect_realize(|area| {
        area.make_current();
        if let Some(error) = area.error() {
            log::warn!("video layer has no GL context: {error}");
            return;
        }
        detect_api();
    });
    area.connect_render(|area, _context| {
        render(area);
        gtk::glib::Propagation::Stop
    });

    let overlay = gtk::Overlay::new();
    parent.remove(&webview);
    overlay.add(&area);
    overlay.add_overlay(&webview);
    if let Some(vbox_parent) = parent.downcast_ref::<gtk::Box>() {
        vbox_parent.pack_start(&overlay, true, true, 0);
    } else {
        parent.add(&overlay);
    }
    overlay.show_all();

    AREA.with(|slot| *slot.borrow_mut() = Some(area));
}

fn on_main<T, F>(app: &AppHandle, f: F) -> Option<T>
where
    T: Send + 'static,
    F: FnOnce() -> T + Send + 'static,
{
    if gtk::is_initialized_main_thread() {
        return Some(f());
    }
    let (tx, rx) = mpsc::channel();
    app.run_on_main_thread(move || {
        let _ = tx.send(f());
    })
    .ok()?;
    rx.recv_timeout(MAIN_THREAD_TIMEOUT).ok()
}

unsafe fn create_context(mpv: *mut mpv_handle) -> Result<(), String> {
    let area = AREA
        .with(|area| area.borrow().clone())
        .ok_or("Video layer is not available")?;
    if !area.is_realized() {
        area.realize();
    }
    area.make_current();
    if let Some(error) = area.error() {
        return Err(format!("No OpenGL context for video: {error}"));
    }
    detect_api();

    let mut context: *mut mpv_render_context = ptr::null_mut();
    let mut init = mpv_opengl_init_params {
        get_proc_address: Some(get_proc_address),
        get_proc_address_ctx: ptr::null_mut(),
        extra_exts: ptr::null(),
    };
    let mut params = [
        mpv_render_param {
            type_: mpv_render_param_type_MPV_RENDER_PARAM_API_TYPE,
            data: MPV_RENDER_API_TYPE_OPENGL.as_ptr() as *mut c_void,
        },
        mpv_render_param {
            type_: mpv_render_param_type_MPV_RENDER_PARAM_OPENGL_INIT_PARAMS,
            data: &mut init as *mut _ as *mut c_void,
        },
        mpv_render_param {
            type_: mpv_render_param_type_MPV_RENDER_PARAM_INVALID,
            data: ptr::null_mut(),
        },
    ];
    let status = mpv_render_context_create(&mut context, mpv, params.as_mut_ptr());
    if status < 0 {
        let reason = CStr::from_ptr(mpv_error_string(status)).to_string_lossy();
        return Err(format!("mpv_render_context_create failed: {reason}"));
    }
    mpv_render_context_set_update_callback(context, Some(on_render_update), ptr::null_mut());
    CONTEXT.store(context as usize, Ordering::SeqCst);
    area.queue_render();
    log::info!(
        "mpv rendering into the GTK video layer ({})",
        if USES_EGL.load(Ordering::SeqCst) {
            "EGL"
        } else {
            "GLX"
        }
    );
    Ok(())
}

/// Bind mpv's `libmpv` video output to the video layer. Must run before
/// `loadfile`: `vo_libmpv` fails if no render context exists when it starts.
pub fn start(app: &AppHandle, mpv: *mut mpv_handle) -> Result<(), String> {
    let mpv = mpv as usize;
    on_main(app, move || unsafe {
        create_context(mpv as *mut mpv_handle)
    })
    .unwrap_or_else(|| Err("Timed out creating the video surface".to_string()))
}

/// Free the render context. Must happen before `mpv_terminate_destroy`.
pub fn detach(app: &AppHandle) {
    let context = CONTEXT.swap(0, Ordering::SeqCst);
    if context == 0 {
        return;
    }
    let freed = on_main(app, move || {
        let area = AREA.with(|area| area.borrow().clone());
        if let Some(area) = area.as_ref() {
            area.make_current();
        }
        unsafe { mpv_render_context_free(context as *mut mpv_render_context) };
        if let Some(area) = area {
            area.queue_render();
        }
    });
    if freed.is_none() {
        log::warn!("timed out freeing the mpv render context");
    }
}

/// libmpv refuses to start unless numbers are formatted the C way, and GTK
/// sets the locale from the environment at startup.
pub fn use_c_numeric_locale() {
    let c = CString::new("C").expect("static string");
    unsafe {
        libc::setlocale(libc::LC_NUMERIC, c.as_ptr());
    }
}
