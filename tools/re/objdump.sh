#!/bin/sh
# PowerPC objdump unpacked from Debian's binutils-powerpc-linux-gnu .deb (no sudo):
#   apt-get download binutils-powerpc-linux-gnu && dpkg -x *.deb ~/.local/opt/ppcbu
P=$HOME/.local/opt/ppcbu/usr
LD_LIBRARY_PATH=$P/lib/x86_64-linux-gnu exec $P/bin/powerpc-linux-gnu-objdump "$@"
