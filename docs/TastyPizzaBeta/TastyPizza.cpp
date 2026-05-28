#include <algorithm>
#include <cstdlib>
#include <iostream>
#include <map>
#include <sstream>
#include <vector>
#include <set>
#include <string>
#include <list>
#include <sys/time.h>
#include <math.h>

using namespace std;

class TastyPizza 
{
public:
  vector<string> findSolution(int C, int R, double X, vector<int> &aCircles, vector<pair<int, int> > &aRect)
  { 
    vector<string> ret;
    ret.push_back("0 0");
    for (size_t i=1; i<C+R; i++) ret.push_back("NA");
    return ret; 
  }
};

int main() 
{
  TastyPizza prog;
  int R, C;
  double X;
  cin >> C >> R >> X;
  vector< pair<int, int> > aRect(R);
  vector<int> aCircles(C);
  for (int i=0;i<C;i++)
  {
    cin >> aCircles[i];
  }
  for (int i=0;i<R;i++)
  {
    cin >> aRect[i].first >> aRect[i].second;
  }
  vector<string> ret = prog.findSolution(C, R, X, aCircles, aRect);
  cout << ret.size() << endl;
  for (int i = 0; i < (int)ret.size(); ++i)
      cout << ret[i] << endl;
  cout.flush();
}