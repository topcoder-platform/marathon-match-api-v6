import java.io.*;

public class TastyPizza
{
  public String[] findSolution(int C, int R, double X, int[] circles, int[][] rectangles)
  {
    String[] out=new String[C+R];
    out[0]="0 0";
    for (int i=1; i<C+R; i++) out[i]="NA";

    return out;
  }

  
  public static void main(String[] args) {
  try {
    BufferedReader br = new BufferedReader(new InputStreamReader(System.in));
    
    int C = Integer.parseInt(br.readLine());
    int R = Integer.parseInt(br.readLine());
    double X = Double.parseDouble(br.readLine());    

    int[] circles=new int[C];
    for (int i=0; i<C; i++)
      circles[i]=Integer.parseInt(br.readLine());

    int[][] rectangles=new int[R][2];
    for (int i=0; i<R; i++)
    {
      String line=br.readLine();
      String[] temp=line.split(" ");
      rectangles[i][0]=Integer.parseInt(temp[0]);
      rectangles[i][1]=Integer.parseInt(temp[1]);
    }
    
    TastyPizza prog = new TastyPizza();
    String[] ret = prog.findSolution(C, R, X, circles, rectangles);

    System.out.println(ret.length);
    for (int i = 0; i < ret.length; i++)
        System.out.println(ret[i]);
  }
  catch (Exception e) {}
  } 
}