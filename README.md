## [Download latest release](../../releases/latest)

## About
VideoTrimmer is a desktop video trimming and compression application built with
Tauri and Svelte, Designed for short form clips. See [INSTALL.md](INSTALL.md) for development and build setup.

## Usage

Application contains a viewable library, selecting a folder will transform all of the located video files into a set grid of hover-able videos which starts their playback, thumbnails will be visible after they generate which can take a some time.

<img width="1178" height="728" alt="image" src="https://github.com/user-attachments/assets/fc939e54-4f18-4384-a8e6-352cef089f8b" />

Clicking on any of these videos will send them directly to the Trimmer part of application. Additionally when you hover over the video and select the circle in top left corner, a multi selection will be possible.

Upon being sent to the Trimmer you will welcome this screen:

<img width="1885" height="962" alt="image" src="https://github.com/user-attachments/assets/748d73f1-c882-4fce-b5aa-1ba7a7559cf6" />

On the left will end up the videos you selected, clicking on white boxes will let you combine all tracks which boxes are selected. Each track opens their own player where you set Start and End time using the side bars, or by Pressing (S) - Start, (E) End based on the current time indicator (red timestamp)

<img width="542" height="138" alt="image" src="https://github.com/user-attachments/assets/23ae9b7f-ecf6-40c8-a8d9-b6266946e53b" />


After doing so you can select your compression mode -> manage

<img width="1046" height="716" alt="image" src="https://github.com/user-attachments/assets/2e522677-90df-4fc3-afdd-ef3fd2912214" />

There are a few "Guide" modes which you can hide or show at will, as well as possibilty to create customs presets

<img width="749" height="800" alt="image" src="https://github.com/user-attachments/assets/c7b3dbf3-61be-4de1-b779-d8f0fb20369d" />

There are a few Rate control options such as, Target MB, percent reduction or constant bitrate, together with multiple video codecs.
When using the MB mode i generally recommend setting your LIMIT for example to 25mb, while the TARGET to few MB less, for example 23. To reduce the risk of overshooting, which will make the video re-encode again.

After all is done and selected, under Settings you can enable Hardware Acceleration, to greatly speed up the processing time, if possible.
When hitting the Trim Video you will be welcomed with one last step.

<img width="533" height="463" alt="image" src="https://github.com/user-attachments/assets/b799b6e5-5b6f-4214-a041-c4f9a2b6e001" />

When selecting the random name generation you can untick the option, as this window will not open, as well as the output folder. 
After its done its job you can either open the file location on keep on editing.

## Additional information
Every changed track that is located in the library will remember the state it was left in, and update the preview as well as thumbnail, when re-opening said video it will open in the exact state if was left in.

Add track, Change video; 
favorite one of options to instantly do said action when pressing the button, or just expand and press on it 

<img width="220" height="119" alt="image" src="https://github.com/user-attachments/assets/5bbd175d-0b99-4621-a5c5-085774046288" />

Go back to library (ctrl + 1) or remove tracks by pressing X right next to every track so start from 0.




