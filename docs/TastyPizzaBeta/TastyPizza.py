import sys

class TastyPizza:

  def findSolution(self, C, R, X, circles, rectangles):
    out = [""] * (C+R)
    out[0] = "0 0"
    for i in range(1,C+R): out[i]="NA"
    return out


C = int(input())
R = int(input())
X = float(input())

circles = [0] * C
for i in range(C):
  circles[i] = int(input())

rectangles = [(0,0)] * R
for i in range(R):
  temp = input().split(" ")
  rectangles[i] = (int(temp[0]), int(temp[1]))
 
prog = TastyPizza()
ret = prog.findSolution(C, R, X, circles, rectangles)

print(len(ret))
for st in ret:
  print(st)
sys.stdout.flush()