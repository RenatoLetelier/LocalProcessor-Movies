# Componentes de terceros

LocalProcessor-Movies se distribuye bajo licencia MIT (ver `LICENSE`). El instalador
incluye además estos programas, que la aplicación ejecuta como procesos
separados y cuyas licencias son las de sus autores:

| Componente | Versión incluida | Licencia | Origen |
|---|---|---|---|
| ffmpeg / ffprobe (Windows) | 8.1.2, build *essentials* | GPL-3.0 (incluye libx264, GPL-2.0+) | https://www.gyan.dev/ffmpeg/builds/ |
| ffmpeg / ffprobe (Linux) | n8.1 (último parche), build estático | GPL-3.0 | https://github.com/BtbN/FFmpeg-Builds |
| ffmpeg / ffprobe (macOS) | 7.1.1, x86_64 (Rosetta 2 en Apple Silicon) | GPL-3.0 | https://evermeet.cx/ffmpeg/ |
| Shaka Packager | v3.9.3 | BSD-3-Clause | https://github.com/shaka-project/shaka-packager |
| Electron, Node.js, Chromium | según `package-lock.json` | MIT / BSD | https://www.electronjs.org/ |

Los textos completos de las licencias de ffmpeg (GPL-3.0), x264 (GPL-2.0) y
Shaka Packager viajan dentro del instalador en la carpeta `resources/licenses/`
(los genera `npm run fetch-bins` junto con los binarios). El código fuente de
ffmpeg y x264 está disponible en los sitios de origen indicados arriba.
