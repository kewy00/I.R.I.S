Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = "D:\I.R.I.S"
WshShell.Run """D:\I.R.I.S\node_modules\electron\dist\electron.exe"" ""D:\I.R.I.S""", 0, False
