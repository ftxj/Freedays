#!/bin/sh
set -eu

# Only the editorially selected map clips are transcoded. Originals remain untouched.
OUT="video/web"
mkdir -p "$OUT"

encode() {
  src="$1"
  name="$2"
  start="$3"
  duration="$4"
  mp4="$OUT/$name.mp4"
  jpg="$OUT/$name.jpg"

  if [ ! -f "$mp4" ]; then
    ffmpeg -hide_banner -loglevel error -ss "$start" -i "$src" -t "$duration" \
      -map 0:v:0 -map '0:a?' -vf "scale='min(1280,iw)':-2,fps=30" \
      -c:v libx264 -preset medium -crf 24 -pix_fmt yuv420p \
      -c:a aac -b:a 128k -movflags +faststart "$mp4"
  fi
  if [ ! -f "$jpg" ]; then
    ffmpeg -hide_banner -loglevel error -ss 1 -i "$mp4" -frames:v 1 -q:v 3 "$jpg"
  fi
}

encode "video/DJI_20241222140359_0205_D.MP4" "pumoyongtso-aerial" 8 18
encode "video/DJI_20241222140742_0207_D.MP4" "pumoyongtso-fpv" 2 16
encode "video/47_raw (1).mp4" "pumoyongtso-shore" 2 16
encode "video/DSC_8185.MOV" "pumoyongtso-ice" 0 18

encode "video/DJI_20241223111844_0215_D.MP4" "kulagangri-aerial" 8 18
encode "video/134_raw (1).mp4" "kulagangri-hiker" 28 18
encode "video/135_raw (1).mp4" "kulagangri-ridge" 4 18

encode "video/252.mp4" "everest-clouds" 0 9
encode "video/DSC_8481(1).MOV" "everest-afterglow" 0 3

encode "video/DJI_20241226145301_0279_D.MP4" "shishapangma-river" 10 18
encode "video/DJI_20241226145712_0289_D.MP4" "shishapangma-offroad" 0 14

encode "video/DJI_20241227102956_0304_D.MP4" "gyirong-yaks" 0 17
encode "video/DJI_20241227113325_0332_D.MP4" "asia-viewpoint-aerial" 22 20
encode "video/346_raw.mp4" "roadside-repair" 36 20

echo "Map video previews ready in $OUT"
