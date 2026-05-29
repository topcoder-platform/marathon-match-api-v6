using System;
using System.Collections.Generic;

public class BlockGame
{
  static void Main(string[] args)  
  {
    int N = int.Parse(Console.ReadLine());        
    int T = int.Parse(Console.ReadLine());              
    int C = int.Parse(Console.ReadLine());              
    double F = double.Parse(Console.ReadLine());              
    double P = double.Parse(Console.ReadLine());              
    
    //read grid
    int[,] grid=new int[N,N];
    for (int r=0; r<N; r++)
      for (int c=0; c<N; c++)
        grid[r,c]=int.Parse(Console.ReadLine());

    //read tiles
    int S=3;
    int[,,] tiles=new int[T,S,S];
    for (int i=0; i<T; i++)
    {
      String line=Console.ReadLine();
      for (int r=0; r<S; r++)
        for (int c=0; c<S; c++)
          tiles[i,r,c]=line[r*S+c]-'0';
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
          if (tiles[id,r2,c2]>0 && grid[r+r2,c+c2]>0) valid = false;
      if (!valid) continue;

      // place tile
      for (int r2=0; r2<S; r2++)
        for (int c2=0; c2<S; c2++)
          if (tiles[id,r2,c2]>0)
            grid[r+r2,c+c2] = tiles[id,r2,c2];
            
      //print move
      Console.WriteLine(id+" "+r+" "+c);
      Console.Out.Flush();   
      
      //read tile
      String line=Console.ReadLine();
      for (int r2=0; r2<S; r2++)
        for (int c2=0; c2<S; c2++)
          tiles[id,r2,c2]=line[r2*S+c2]-'0';
        
      int elapsedTime=int.Parse(Console.ReadLine());
    }
    //terminate
    Console.WriteLine("-1");
    Console.Out.Flush();              
  }
}