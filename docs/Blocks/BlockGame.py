import sys

N = int(input())
T = int(input())
C = int(input())
F = float(input())
P = float(input())

# read grid
grid = [[0 for x in range(N)] for y in range(N)]
for r in range(N):
  for c in range(N):
    grid[r][c] = int(input())

# read tiles
S=3;
tiles = [[[0 for x in range(S)] for y in range(S)] for z in range(T)]
for i in range(T):
  line=input()
  for r in range(S):
    for c in range(S):
      tiles[i][r][c]=ord(line[r*S+c])-ord('0')
  

q=N//S

for i in range(1000):        
  Id=i%T;
  r=((i//q)*S)%(N-2);
  c=((i%q)*S)%(N-2);
  
  # check for a valid move
  valid = True
  for r2 in range(S):
    for c2 in range(S):
      if tiles[Id][r2][c2]>0 and grid[r+r2][c+c2]>0: valid = False
  if not(valid): continue

  # place tile
  for r2 in range(S):
    for c2 in range(S):  
      if tiles[Id][r2][c2]>0:
        grid[r+r2][c+c2] = tiles[Id][r2][c2]
        
  # print move
  print(str(Id)+" "+str(r)+" "+str(c))
  sys.stdout.flush()
  
  # read tile
  line=input()
  for r2 in range(S):
    for c2 in range(S):    
      tiles[Id][r2][c2]=ord(line[r2*S+c2])-ord('0')
    
  elapsedTime = int(input())

# terminate
print("-1");
sys.stdout.flush()