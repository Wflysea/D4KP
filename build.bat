@echo off
REM 4K图片批量下载器 - 打包脚本（生成单文件 exe，约 5MB）
REM 环境：Python 3.13 + pip install pyinstaller + 同目录放 upx 文件夹(含 upx.exe)
REM 用法：先 pip install pyinstaller，把 upx.exe 放到 upx\ 或 upx\upx-4.2.4-win64\，双击本文件即可。

setlocal
set UPX_DIR=upx
if not exist "%UPX_DIR%\upx.exe" if exist "upx\upx-4.2.4-win64\upx.exe" set UPX_DIR=upx\upx-4.2.4-win64

pyinstaller --onefile --windowed --name 4kdownloader --python-option OO --upx-dir %UPX_DIR% --exclude-module tkinter --exclude-module turtle --exclude-module idlelib --exclude-module test --exclude-module unittest --exclude-module doctest --exclude-module pydoc --exclude-module ensurepip --exclude-module pip --exclude-module setuptools --exclude-module lib2to3 --exclude-module curses --exclude-module venv --exclude-module distutils --exclude-module sqlite3 --exclude-module asyncio --exclude-module xmlrpc --exclude-module decimal --exclude-module mailbox --exclude-module multiprocessing --exclude-module wsgiref --exclude-module tarfile --exclude-module pdb --exclude-module bdb --exclude-module cmd --exclude-module code --exclude-module profile --exclude-module pstats --exclude-module cProfile --exclude-module trace --exclude-module xml --exclude-module xml.etree --exclude-module xml.dom --exclude-module xml.sax --exclude-module dbm --exclude-module optparse --exclude-module argparse --exclude-module calendar --exclude-module cgi --exclude-module cgitb --exclude-module mailcap --exclude-module readline --exclude-module rlcompleter --exclude-module nntplib --exclude-module smtpd --exclude-module telnetlib --exclude-module audioop --exclude-module imghdr --exclude-module sndhdr --exclude-module sunau --exclude-module wave --exclude-module chunk --exclude-module colorsys --exclude-module filecmp --exclude-module fileinput --exclude-module formatter --exclude-module getopt --exclude-module getpass --exclude-module gzip --exclude-module bz2 --exclude-module lzma --exclude-module zipapp --exclude-module antigravity --exclude-module this --exclude-module ssl --exclude-module _ssl --exclude-module http --exclude-module email --exclude-module socketserver --exclude-module urllib --exclude-module urllib.request --exclude-module urllib.parse --exclude-module urllib.error --exclude-module _decimal --exclude-module pyexpat --exclude-module html --exclude-module html.parser --exclude-module html.entities --exclude-module unicodedata image_downloader.py

echo.
echo 构建完成，exe 位于 dist\4kdownloader.exe
pause
