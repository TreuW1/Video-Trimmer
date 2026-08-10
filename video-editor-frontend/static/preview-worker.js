// Preview Worker for generating video thumbnails
// This worker runs in the background to generate timeline thumbnails

let canvas = null;
let video = null;

// Initialize canvas and video elements
function initElements() {
  if (!canvas) {
    canvas = new OffscreenCanvas(160, 90); // 16:9 aspect ratio, small size for performance
  }
  if (!video) {
    video = new Video();
    video.muted = true;
    video.volume = 0;
  }
}

// Generate thumbnail for a specific time
function generateThumbnail(videoSrc, time) {
  return new Promise((resolve, reject) => {
    initElements();
    
    const ctx = canvas.getContext('2d');
    
    video.src = videoSrc;
    video.currentTime = time;
    
    video.onloadeddata = () => {
      try {
        // Draw video frame to canvas
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        
        // Convert to blob
        canvas.convertToBlob({ type: 'image/jpeg', quality: 0.7 })
          .then(blob => {
            // Convert blob to data URL for easy transfer
            const reader = new FileReader();
            reader.onload = () => {
              resolve(reader.result);
            };
            reader.readAsDataURL(blob);
          })
          .catch(reject);
      } catch (error) {
        reject(error);
      }
    };
    
    video.onerror = reject;
    
    // Timeout after 5 seconds
    setTimeout(() => {
      reject(new Error('Thumbnail generation timeout'));
    }, 5000);
  });
}

// Handle messages from main thread
self.onmessage = async function(event) {
  const { type, videoSrc, times } = event.data;
  
  try {
    switch (type) {
      case 'generate_thumbnails':
        // Generate thumbnails for multiple times
        for (const time of times) {
          try {
            const thumbnail = await generateThumbnail(videoSrc, time);
            self.postMessage({
              type: 'thumbnail_ready',
              time: time,
              thumbnail: thumbnail
            });
          } catch (error) {
            console.warn(`Failed to generate thumbnail for time ${time}:`, error);
          }
        }
        break;
        
      case 'generate_single_thumbnail':
        const { time } = event.data;
        const thumbnail = await generateThumbnail(videoSrc, time);
        self.postMessage({
          type: 'thumbnail_ready',
          time: time,
          thumbnail: thumbnail
        });
        break;
        
      default:
        console.warn('Unknown message type:', type);
    }
  } catch (error) {
    self.postMessage({
      type: 'error',
      error: error.message
    });
  }
};

// Clean up resources
self.onclose = function() {
  if (video) {
    video.src = '';
    video = null;
  }
  if (canvas) {
    canvas = null;
  }
}; 