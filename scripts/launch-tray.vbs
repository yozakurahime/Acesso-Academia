Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
rootDir = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
trayScript = fso.BuildPath(rootDir, "scripts\edge-tray.ps1")
cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & trayScript & """"
shell.CurrentDirectory = rootDir
shell.Run cmd, 0, False
