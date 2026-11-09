#!/bin/sh
# print annot lines from $1 to $2 (hex, no 0x)
awk -v a="$1" -v b="$2" 'substr($1,1,8)>=a && substr($1,1,8)<b' /tmp/tanks_re/annot.txt | cut -c1-120
