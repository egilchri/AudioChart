# sh sheet.sh out.jpg a.png b.png c.png d.png: a 2x2 contact sheet (each 1200x600)
o=$1; shift; ffmpeg -loglevel error -y -i $1 -i $2 -i $3 -i $4 -filter_complex "[0][1]hstack[t];[2][3]hstack[b];[t][b]vstack" -q:v 3 $o
