@echo off
rem chat 的 Windows 启动器：把本文件所在目录放进 PATH，就能直接打 chat
node "%~dp0chat.mjs" %*
