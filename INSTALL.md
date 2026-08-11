# Installation Guide

This guide will help you install all dependencies needed to run the Video Editor application.

## Installation Steps

Download and install the latest release, as well as FFmpeg (step 4, or download from official website) and set it to your system PATH
or:

### Step 1: Install System Dependencies

1. Install Node.js from https://nodejs.org/
3. Install Rust by running:
   ```powershell
   winget install Rustlang.Rustup
   ```
   Or visit https://rustup.rs/
4. Install FFmpeg:
   ```powershell
   winget install Gyan.FFmpeg
   ```
5. (Optional) Install MSYS2 from https://www.msys2.org/
   ```powershell
   winget install --id MSYS2.MSYS2 -e --source winget
   ```
   Open MSYS2: 
   ```
   pacman -S --needed base-devel mingw-w64-ucrt-x86_64-toolchain \
    mingw-w64-ucrt-x86_64-nasm
   ```
   Select mingw-w64-x86_64-gcc

6. Change the default toolset IF installed MSyS2 by:
    ```powershell
    rustup default stable-x86_64-pc-windows-gnu
    rustup target add x86_64-pc-windows-gnu
    ```

### Step 2: Verify Installations

Open PowerShell and verify each tool:
```powershell
node --version
npm --version
cargo --version
rustc --version
ffmpeg -version
```

### Step 3: Install npm Dependencies

After all system dependencies are installed:

```powershell
# Install root dependencies
npm install

# Install frontend dependencies
npm install --prefix video-editor-frontend
```

Or run the automated installer:
```powershell
powershell -ExecutionPolicy Bypass -File ./install-dependencies.ps1
```

### Step 4: Run the Application 

```powershell
# Build mode (exe file)
npm run tauri build

Wait for the build to complete, can take a few minutes.
When the compiler finishes locate:
trimmer\src-tauri\target\x86_64-pc-windows-gnu\release\bundle\nsis\VideoTrimmer_1.0.0_x64-setup.exe
Install to desired location.
