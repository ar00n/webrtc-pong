
# WebRTC Pong

A lightweight, serverless peer-to-peer Pong game built with WebRTC and [Trystero](https://github.com/dmotz/trystero). Create a room, share the room code or invite link with a friend, and play directly in the browser.

<img src="https://github.com/ar00n/webrtc-pong/blob/main/example.jpg" width="800" alt="Example">

## Features

- **Serverless P2P Multiplayer:** Uses WebRTC data channels via Trystero—no dedicated game server required.
- **Room Codes & Invite Links:** Host a match with an auto-generated room code (e.g., `UANX2`) and share it with one-click **Copy Code** or **Copy Invite Link** buttons.
- **Live Latency Display:** Shows real-time connection ping (`ms`) and host/paddle assignment.
- **Game & Audio Controls:** Built-in pause/resume, score reset, sound toggle, and volume slider.
- **Cross-Device Input:** Play with mouse, touch drag, or keyboard.

## Controls

| Action | Input |
| --- | --- |
| Move Paddle | `Mouse` / `Touch drag` / `W` & `S` / `Arrow Up` & `Arrow Down` |
| Pause / Resume | `Space` |
| Mute / Unmute | `M` |

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) (v18+ recommended)

### Build

1. Clone the repository:
   ```bash
   git clone https://github.com/ar00n/webrtc-pong.git
   cd webrtc-pong
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Build the project:
   ```bash
   npm run build
   ```

## Tech Stack

- **[Trystero](https://github.com/dmotz/trystero)** — Serverless WebRTC matchmaking and peer communication
- **[esbuild](https://esbuild.github.io/)** — JavaScript bundling
- **[html-minifier-terser](https://github.com/terser/html-minifier-terser)** — HTML minification

## License

This project is licensed under the [ISC License](LICENSE).