using System;
using System.Collections.Generic;

public class TastyPizza
{
  public string[] findSolution(int C, int R, double X, int[] circles, int[,] rectangles)
  {  
    string[] ret = new string[C+R];
    ret[0] = "0 0";
    for (int i=1; i<C+R; i++) ret[i]="NA";
    return ret;
  } 
  
  static void Main(string[] args)
  {
    int C = int.Parse(Console.ReadLine());        
    int R = int.Parse(Console.ReadLine());   
    double X = double.Parse(Console.ReadLine());     

    int[] circles = new int[C];
    for (int i=0; i<C; i++)
      circles[i] = int.Parse(Console.ReadLine());        

    int[,] rectangles = new int[R,2];    
    for (int i=0; i<R; i++)
    {
      string[] temp = Console.ReadLine().Split(' ');
      rectangles[i,0] = int.Parse(temp[0]);
      rectangles[i,1] = int.Parse(temp[1]);
    }

    TastyPizza prog = new TastyPizza();
    string[] ret = prog.findSolution(C, R, X, circles, rectangles);

    Console.WriteLine(ret.Length);
    for (int i = 0; i < ret.Length; i++)
      Console.WriteLine(ret[i]);
  }
}