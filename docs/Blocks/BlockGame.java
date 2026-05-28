import java.io.*;
import java.util.*;

public class BlockGame
{
  public static void main(String[] args) throws Exception
  {           
    BufferedReader in = new BufferedReader(new InputStreamReader(System.in));    
    
    int N=Integer.parseInt(in.readLine());   
    int T=Integer.parseInt(in.readLine());   
    int C=Integer.parseInt(in.readLine());   
    double F=Double.parseDouble(in.readLine());     
    double P=Double.parseDouble(in.readLine());     

    //read grid         
    int[][] grid=new int[N][N];
    for (int r=0; r<N; r++)
      for (int c=0; c<N; c++)
        grid[r][c]=Integer.parseInt(in.readLine());
      
    //read tiles
    int S=3;
    int[][][] tiles=new int[T][S][S];
    for (int i=0; i<T; i++)
    {
      String line=in.readLine();
      for (int r=0; r<S; r++)
        for (int c=0; c<S; c++)
          tiles[i][r][c]=(int)(line.charAt(r*S+c)-'0');
    }
      
    
    int q=N/S;
            
    for (int i=0; i<1000; i++)
    {
      int id=i%T;
      int r=((i/q)*S)%(N-2);
      int c=((i%q)*S)%(N-2);

      // check for a valid move
      boolean valid = true;
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
      System.out.println(id+" "+r+" "+c);
      System.out.flush();   
      
      //read tile
      String line=in.readLine();
      for (int r2=0; r2<S; r2++)
        for (int c2=0; c2<S; c2++)
          tiles[id][r2][c2]=(int)(line.charAt(r2*S+c2)-'0');
        
      int elapsedTime=Integer.parseInt(in.readLine());
    }
    //terminate
    System.out.println("-1");
    System.out.flush();       
  }
}