//! Detección y cierre de procesos que tienen un archivo abierto, usando
//! Restart Manager (rstrtmgr.dll) — el mismo mecanismo que usa Windows en
//! los instaladores para avisar "este archivo está en uso por: ...".
#![cfg(windows)]

use std::ffi::OsStr;
use std::os::windows::ffi::OsStrExt;

#[allow(non_snake_case)]
#[repr(C)]
struct FILETIME {
    dwLowDateTime: u32,
    dwHighDateTime: u32,
}

#[allow(non_snake_case)]
#[repr(C)]
struct RM_UNIQUE_PROCESS {
    dwProcessId: u32,
    ProcessStartTime: FILETIME,
}

const CCH_RM_MAX_APP_NAME: usize = 255;
const CCH_RM_MAX_SVC_NAME: usize = 63;
const CCH_RM_SESSION_KEY: usize = 32;

#[allow(non_snake_case)]
#[repr(C)]
struct RM_PROCESS_INFO {
    Process: RM_UNIQUE_PROCESS,
    strAppName: [u16; CCH_RM_MAX_APP_NAME + 1],
    strServiceShortName: [u16; CCH_RM_MAX_SVC_NAME + 1],
    ApplicationType: i32,
    AppStatus: u32,
    TSSessionId: u32,
    bRestartable: i32,
}

#[link(name = "rstrtmgr")]
extern "system" {
    fn RmStartSession(pSessionHandle: *mut u32, dwSessionFlags: u32, strSessionKey: *mut u16) -> u32;
    fn RmEndSession(dwSessionHandle: u32) -> u32;
    fn RmRegisterResources(
        dwSessionHandle: u32,
        nFiles: u32,
        rgsFilenames: *const *const u16,
        nApplications: u32,
        rgApplications: *const RM_UNIQUE_PROCESS,
        nServices: u32,
        rgsServiceNames: *const *const u16,
    ) -> u32;
    fn RmGetList(
        dwSessionHandle: u32,
        pnProcInfoNeeded: *mut u32,
        pnProcInfo: *mut u32,
        rgAffectedApps: *mut RM_PROCESS_INFO,
        lpdwRebootReasons: *mut u32,
    ) -> u32;
}

extern "system" {
    fn OpenProcess(dwDesiredAccess: u32, bInheritHandle: i32, dwProcessId: u32) -> isize;
    fn TerminateProcess(hProcess: isize, uExitCode: u32) -> i32;
    fn CloseHandle(hObject: isize) -> i32;
}

const PROCESS_TERMINATE: u32 = 0x0001;

fn a_wide(s: &str) -> Vec<u16> {
    OsStr::new(s).encode_wide().chain(std::iter::once(0)).collect()
}

pub struct ProcesoBloqueante {
    pub nombre: String,
    pub pid: u32,
}

/// Devuelve los procesos que tienen abierto alguno de los archivos indicados.
/// Si algo falla a nivel de API de Windows, devuelve una lista vacía en vez
/// de un error (no queremos bloquear el flujo normal por esto).
pub fn procesos_bloqueando(rutas: &[String]) -> Vec<ProcesoBloqueante> {
    let mut resultado = Vec::new();
    if rutas.is_empty() {
        return resultado;
    }

    unsafe {
        let mut sesion: u32 = 0;
        let mut clave_sesion = [0u16; CCH_RM_SESSION_KEY + 1];
        if RmStartSession(&mut sesion, 0, clave_sesion.as_mut_ptr()) != 0 {
            return resultado;
        }

        let rutas_wide: Vec<Vec<u16>> = rutas.iter().map(|r| a_wide(r)).collect();
        let punteros: Vec<*const u16> = rutas_wide.iter().map(|r| r.as_ptr()).collect();

        let registrado = RmRegisterResources(
            sesion,
            punteros.len() as u32,
            punteros.as_ptr(),
            0,
            std::ptr::null(),
            0,
            std::ptr::null(),
        );

        if registrado == 0 {
            let mut necesarios: u32 = 0;
            let mut disponibles: u32 = 0;
            let mut razon: u32 = 0;
            // Primera llamada solo para averiguar cuántos procesos hay.
            RmGetList(sesion, &mut necesarios, &mut disponibles, std::ptr::null_mut(), &mut razon);

            if necesarios > 0 {
                let mut buffer: Vec<RM_PROCESS_INFO> = Vec::with_capacity(necesarios as usize);
                for _ in 0..necesarios {
                    buffer.push(std::mem::zeroed());
                }
                let mut capacidad = necesarios;
                let codigo = RmGetList(
                    sesion,
                    &mut necesarios,
                    &mut capacidad,
                    buffer.as_mut_ptr(),
                    &mut razon,
                );
                if codigo == 0 {
                    for info in buffer.iter().take(capacidad as usize) {
                        let fin = info
                            .strAppName
                            .iter()
                            .position(|&c| c == 0)
                            .unwrap_or(info.strAppName.len());
                        let nombre = String::from_utf16_lossy(&info.strAppName[..fin]);
                        resultado.push(ProcesoBloqueante {
                            nombre: if nombre.trim().is_empty() {
                                format!("Proceso {}", info.Process.dwProcessId)
                            } else {
                                nombre
                            },
                            pid: info.Process.dwProcessId,
                        });
                    }
                }
            }
        }

        RmEndSession(sesion);
    }

    // Quitar duplicados (el mismo proceso puede bloquear varios archivos a la vez).
    resultado.sort_by_key(|p| p.pid);
    resultado.dedup_by_key(|p| p.pid);
    resultado
}

/// Cierra un proceso por su PID. Es un cierre forzado (TerminateProcess),
/// no un cierre amable: si el programa tenía cambios sin guardar, se pierden.
pub fn cerrar_proceso(pid: u32) -> Result<(), String> {
    unsafe {
        let handle = OpenProcess(PROCESS_TERMINATE, 0, pid);
        if handle == 0 {
            return Err(format!("No se pudo abrir el proceso {} para cerrarlo", pid));
        }
        let ok = TerminateProcess(handle, 0);
        CloseHandle(handle);
        if ok == 0 {
            return Err(format!("No se pudo cerrar el proceso {}", pid));
        }
    }
    Ok(())
}
