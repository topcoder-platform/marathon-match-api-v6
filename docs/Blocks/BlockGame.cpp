#include <vector>
#include <iostream>
using namespace std;

int main() 
{
  int N, T, C;
  double F, P;
  cin >> N >> T >> C >> F >> P;

  //read grid
  int grid[N][N];
  for (int r=0; r<N; r++)
    for (int c=0; c<N; c++)
    {
      cin >> grid[r][c];
    }

  //read tiles
  const int S=3;
  int tiles[T][S][S];
  for (int i=0; i<T; i++)
  {
    string line;
    cin >> line;
    for (int r=0; r<S; r++)
      for (int c=0; c<S; c++)
        tiles[i][r][c] = (int)(line[r*S+c]-'0');
  }

  int q=N/S;
          
  for (int i=0; i<1000; i++)
  {
    int id=i%T;
    int r=((i/q)*S)%(N-2);
    int c=((i%q)*S)%(N-2);
    
    // check for a valid move
    bool valid = true;
    for (int r2=0; r2<S; r2++)
      for (int c2=0; c2<S; c2++)
        if (tiles[id][r2][c2]>0 && grid[r+r2][c+c2]>0) valid = false;
    if (!valid) continue;

    // place tile
    for (int r2=0; r2<S; r2++)
      for (int c2=0; c2<S; c2++)
        if (tiles[id][r2][c2]>0)
          grid[r+r2][c+c2] = tiles[id][r2][c2];

    //print move
    cout << id << " " << r << " " << c << endl;
    cout.flush();
    
    //read tile
    string line;
    cin >> line;
    for (int r2=0; r2<S; r2++)
      for (int c2=0; c2<S; c2++)
        tiles[id][r2][c2] = (int)(line[r2*S+c2]-'0');
      
    int elapsedTime;
    cin >> elapsedTime;
  }

  //terminate
  cout << "-1" << endl;
  cout.flush();
}
