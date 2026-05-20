import java.awt.*;
import java.awt.geom.*;
import java.util.*;
import java.io.*;
import javax.imageio.*;
import java.util.List;
import java.util.ArrayList;
import java.awt.image.BufferedImage;

import com.topcoder.marathon.*;

/**
 * Marathon Match tester fixture for the TCO22 Blocks challenge.
 *
 * The full Marathon Match test runner uploads this source as the custom tester
 * and invokes it by the {@code BlockGameTester} class name configured in the
 * fixture manifest. The tester generates Blocks game cases from configured
 * seeds, streams each case to a submitted solution, validates moves, and returns
 * the aggregate maximize score used by Marathon Match scoring.
 */
public class BlockGameTester extends MarathonAnimatedVis
{
  // Parameter ranges
  private static final int minN = 6, maxN = 20;        // grid size range
  private static final int minT = 1, maxT = 5;         // number of tiles range
  private static final int minC = 1, maxC = 5;         // number of fruits range
  private static final double minF = 0, maxF = 0.3;    // grid fill ratio range
  private static final double minP = 0.2, maxP = 0.5;    // polyomino fill ratio range
  
  // Inputs
  private int N;                // grid size
  private int T;                // number of tiles
  private int C;                // number of fruits
  private double F;             // grid fill ratio
  private double P;             // polyomino fill ratio

  // Constants
  private static final int Turns=1000;          // number of turns in the simulation
  private static final int TileSize=3;          // size of each tile
  
  // Drawing
  private static Image[] images;
  private static final String[] Names={"apple.png", "strawberry2.png", "orange.png", "grapes.png", "pear.png"};
  private static final Color[] colors={Color.green, Color.red, Color.orange, Color.blue, new Color(97, 54, 19)};
    
  // State Control
  private int[][] grid;    
  private int[][][] tiles;
  private int[] curTiles;
  private int[] countsV;
  private int[] countsH;
  private List<Integer> clearedH;
  private List<Integer> clearedV;
  private int ID;
  private int ROW;
  private int COL;
  private int Drops;
  private int Turn;
  private int LastScore;
  private int MaxScore;
  private int LinesCleared;
  private int Score;  


  protected void generate()
  {
    N = randomInt(minN, maxN);
    T = randomInt(minT, maxT);
    C = randomInt(minC, maxC);    
    F = randomDouble(minF, maxF);
    P = randomDouble(minP, maxP);
    
    //Special cases
    if (seed == 1)
    {
      N = minN;
      T = maxT;
      C = maxC;
      P = 0.35;
    }
    else if (seed == 2)
    {
      N = maxN;
      T = minT;
      C = maxC;
      P = maxP;
    }
    
    //User defined parameters
    if (parameters.isDefined("N")) N = randomInt(parameters.getIntRange("N"), minN, maxN);
    if (parameters.isDefined("T")) T = randomInt(parameters.getIntRange("T"), minT, maxT);
    if (parameters.isDefined("C")) C = randomInt(parameters.getIntRange("C"), minC, maxC);
    if (parameters.isDefined("F")) F = randomDouble(parameters.getDoubleRange("F"), minF, maxF);
    if (parameters.isDefined("P")) P = randomDouble(parameters.getDoubleRange("P"), minP, maxP);
    
    //generate grid
    while(true)
    {
      boolean ok=generateGrid();
      if (ok) break;
      //else { printGrid(); System.out.println(); }
    }
        
    //generate tiles
    tiles=new int[Turns+T][TileSize][TileSize];
    for (int i=0; i<tiles.length;)
    {
      int filled=0;
      int fruit=randomInt(1,C);      
      for (int r=0; r<TileSize; r++)
        for (int c=0; c<TileSize; c++)
          if (randomDouble(0,1) < P)
          {
            tiles[i][r][c]=fruit;
            filled++;
          }
                 
      if (filled>=1) i++;    //make sure there is at least one cell filled
    }
          

    curTiles=new int[T];
    for (int i=0; i<T; i++) curTiles[i]=i;
    
    clearedH=new ArrayList<Integer>();
    clearedV=new ArrayList<Integer>();    
    ROW=-100;
    COL=-100;
    ID=-1;
    
    if (debug)
    {
      System.out.println("Grid size, N = " + N);
      System.out.println("Number of tiles, T = " + T);
      System.out.println("Number of fruits, C = " + C);
      System.out.println("Grid fill ratio, F = " + F);
      System.out.println("Polyomino fill ratio, P = " + P);
      System.out.println("Grid:");
      printGrid();
      System.out.println("Starting tiles:");
      for (int i=0; i<T; i++)
        System.out.println((i+1)+". "+tile2string(tiles[i]));
    }    
  }
  
  
  private void printGrid()
  {
    for (int row = 0; row < N; row++)
    {
      for (int col = 0; col < N; col++)
        System.out.print(grid[row][col]);
      System.out.println();
    }    
  }
  

  //generate starting grid  
  //returns true if grid is valid
  private boolean generateGrid()
  {
    grid = new int[N][N];    
    countsH = new int[N];
    countsV = new int[N];

    for (int r=0; r<N; r++)
      for (int c=0; c<N; c++)
        if (randomDouble(0,1) < F)
        {
          grid[r][c]=randomInt(1,C);
          countsH[r]++;
          countsV[c]++;
    
          //check that there are no formed lines    
          if (countsH[r]==N) return false;
          if (countsV[c]==N) return false;
        }    
        
        
    //make sure that at least one TileSize x TileSize is empty
    for (int r=0; r<N-TileSize+1; r++)
loop:      
      for (int c=0; c<N-TileSize+1; c++)
      {
        for (int r2=r; r2<r+TileSize; r2++)
          for (int c2=c; c2<c+TileSize; c2++)
            if (grid[r2][c2]!=0) continue loop;
          
        return true;
      }
      
    return false;
  }
  
  
  private String tile2string(int[][] tile)
  {
    String out="";
    for (int r=0; r<TileSize; r++)
      for (int c=0; c<TileSize; c++)
        out+=tile[r][c];

    return out;
  }
    
  
  protected boolean isMaximize() {
      return true;
  }

  protected double run() throws Exception {
    init();
    return runAuto();
  }

  protected double runAuto() throws Exception {
    double Score = callSolution();
    if (Score < 0) {
      if (!isReadActive()) return getErrorScore();
      return fatalError();
    }
    return Score;
  }

  protected void timeout() {
    addInfo("Time", getRunTime());
    update();
  }


  private double callSolution() throws Exception {
    writeLine(""+N);
    writeLine(""+T);
    writeLine(""+C);
    writeLine(""+F);
    writeLine(""+P);
    // print the grid
    for (int r = 0; r < N; r++)
      for (int c = 0; c < N; c++)
        writeLine(""+grid[r][c]);
    // print tiles
    for (int i=0; i<T; i++)
      writeLine(tile2string(tiles[i]));
    flush();    
    if (!isReadActive()) return -1;

    Score=0;
    MaxScore=0;
    LinesCleared=0;
    LastScore=0;      
    Drops=0;
    ID=-1;
    ROW=-100;
    COL=-100;
    
    updateState();

    try
    {
      for (Turn=1; Turn<=Turns; Turn++)
      {   
        // Get the solution
        startTime();        
        String[] temp=readLine().split(" ");
        stopTime();
        
        if (!(temp.length==1 || temp.length==3))
          return fatalError("There must be exactly 1 or 3 integers representing your move");        
        
        int id=Integer.parseInt(temp[0]);        
        
        //terminate the simulation
        if (temp.length==1 && id==-1) break;
        
        if (id<0 || id>=T)
          return fatalError("The tile number must be between 0 and "+(T-1)+" inclusive");
                
        //drop tile
        if (temp.length==1)
        {
          Drops++;
          ID=id;
          ROW=-100;
          COL=-100;
          updateState();          
          ID=-1;
        }

        //place tile
        if (temp.length==3)
        {
          int r=Integer.parseInt(temp[1]);
          int c=Integer.parseInt(temp[2]);
          
          if (r<=-TileSize || r>=N || c<=-TileSize || c>=N)
            return fatalError("The tile coordinates must be between "+(-TileSize+1)+" and "+(N-1)+" inclusive");              
               
          int tile=curTiles[id];
          
          //place tile
          for (int r2=0; r2<TileSize; r2++)
            for (int c2=0; c2<TileSize; c2++)
            {
              if (tiles[tile][r2][c2]==0) continue;
              
              int r3=r2+r;
              int c3=c2+c;
              if (!inGrid(r3,c3))
                return fatalError("Cannot place any tiles outside the grid");
              
              if (grid[r3][c3]!=0)
                return fatalError("cannot place at ("+r3+","+c3+") as its not empty");
              
              grid[r3][c3]=tiles[tile][r2][c2];
              countsH[r3]++;
              countsV[c3]++;
            }
          
          
          //show placed tile
          ID=id;
          ROW=r;
          COL=c;          
          updateState();
          ROW=-100;
          COL=-100;        
          ID=-1;

          //clear any lines
          clearedH.clear();
          clearedV.clear();
          for (int i=0; i<N; i++)
          {
            if (countsH[i]==N) clearedH.add(i);
            if (countsV[i]==N) clearedV.add(i);
          }
          
          int clearedLines=clearedH.size()+clearedV.size();
          
          if (clearedLines>0)
          {
            updateState();    
            
            LastScore=0;
                    
            //update line scores
            for (int r2 : clearedH)
            {
              int max=0;
              int[] cleared=new int[C+1];
              for (int c2=0; c2<N; c2++)
                if (grid[r2][c2]>0)
                {
                  cleared[grid[r2][c2]]++;
                  max=Math.max(max,cleared[grid[r2][c2]]);
                }
                
              LastScore+=clearedLines*max*max;              
            }

            for (int c2 : clearedV)
            {
              int max=0;
              int[] cleared=new int[C+1];
              for (int r2=0; r2<N; r2++)
                if (grid[r2][c2]>0)
                {
                  cleared[grid[r2][c2]]++;
                  max=Math.max(max,cleared[grid[r2][c2]]);
                }        
                
              LastScore+=clearedLines*max*max;                            
            }
            
            //clear lines
            for (int r2 : clearedH)
              for (int c2=0; c2<N; c2++)
                if (grid[r2][c2]>0)
                {
                  countsH[r2]--;
                  countsV[c2]--;
                  grid[r2][c2]=0;
                }    

            for (int c2 : clearedV)
              for (int r2=0; r2<N; r2++)
                if (grid[r2][c2]>0)
                {
                  countsH[r2]--;
                  countsV[c2]--;
                  grid[r2][c2]=0;
                }                
            
            LinesCleared+=clearedLines;
            MaxScore=Math.max(MaxScore,LastScore);
            Score+=LastScore;
            
            clearedH.clear();
            clearedV.clear();
          }        
        }
        
        //print new tile
        curTiles[id]=Turn+T-1;
        writeLine(tile2string(tiles[Turn+T-1]));
        
        //print elapsed time
        writeLine(""+getRunTime());
        flush();  
                
        updateState();
      }
    }
    catch (Exception e) {
      if (debug) System.out.println(e.toString());
      return fatalError("Cannot parse your output");
    }

    return Score;
  }
    
  private boolean inGrid(int row, int col)
  {
    return row >= 0 && row < N && col >= 0 && col < N;
  }  
  
  
  protected void updateState()
  {
    if (hasVis())
    {      
      synchronized (updateLock)
      {      
        addInfo("Turn", Turn);
        addInfo("Last clearance", LastScore);
        addInfo("Max clearance", MaxScore);
        addInfo("Lines cleared", LinesCleared);
        addInfo("Drops", Drops);
        addInfo("Score", Score);               
        addInfo("Time", getRunTime());   
      }
      updateDelay();
    }
  }   
 

  protected void paintContent(Graphics2D g)
  {    
    adjustFont(g, Font.SANS_SERIF, Font.PLAIN, String.valueOf("1"), new Rectangle2D.Double(0, 0, 0.5, 0.5));
    g.setStroke(new BasicStroke(0.005f, BasicStroke.CAP_ROUND, BasicStroke.JOIN_ROUND));
    
    //draw field
    g.setColor(Color.white);
    g.fillRect(0,0,N,N);     
           
    //draw grid blocks
    for (int r=0; r<N; r++)
      for (int c=0; c<N; c++)
        if (grid[r][c]!=0)
          if (parameters.isDefined("noImages"))
          {
            g.setColor(colors[grid[r][c]-1]);
            g.fillRect(c,r,1,1);
          }
          else
          {
            g.drawImage(images[grid[r][c]-1],c,r,1,1,null);          
          }
        
    //draw grid  
    g.setColor(Color.black);
    for (int i = 0; i < N+1; i++)
    {
      g.drawLine(i,0,i,N);
      g.drawLine(0,i,N,i);
    }    

           
    //draw current tiles    
    double gap=0.25;
    double tileHeight=TileSize-gap*2;
    double tileWidth=(N-gap*(T+1))*1.0/T;
    double size=Math.min(tileHeight,tileWidth);
    double size2=size/TileSize;
    double gapH=(N-T*size)/(T+1);
    double gapV=(TileSize-size)/2.0;

    for (int i=0; i<T; i++)
    {
      int[][] tile=tiles[curTiles[i]];
      
      for (int r=0; r<TileSize; r++)
        for (int c=0; c<TileSize; c++)
        {              
          double c2=gapH+gapH*i+size*i+c*size2;
          double r2=N+gapV+r*size2;
          
          Rectangle2D t = new Rectangle2D.Double(c2,r2,size2,size2);
          
          if (tile[r][c]==0) g.setColor(Color.white);    
          else if (parameters.isDefined("noImages"))            
          {
            g.setColor(colors[tile[r][c]-1]);            
            g.fill(t);
          }
          else
          {
            //a very complicated and possibly slow way to draw images with non-integer coordinates
            //from https://stackoverflow.com/questions/8676909/drawing-an-image-using-sub-pixel-level-accuracy-using-graphics2d
            Image img=images[tile[r][c]-1];
            AffineTransform at = new AffineTransform();
            at.translate(c2, r2);
            at.scale(size2*1.0/img.getWidth(null), size2*1.0/img.getHeight(null));
            g.drawImage(img, at, null);
            //g.drawImage(images[tile[r][c]-1],c2,r2,size2,size2,null);      //doesn't work
          }
          
          g.setColor(Color.black);
          g.draw(t);
        } 
    }
    
    //highlight chosen tile and where it is placed
    if (ID!=-1)
    {
      g.setStroke(new BasicStroke(0.05f, BasicStroke.CAP_ROUND, BasicStroke.JOIN_ROUND));
      g.setColor(Color.black);
      Rectangle2D t = new Rectangle2D.Double(gapH+gapH*ID+size*ID, N+gapV, size, size);
      g.draw(t);
    }

    //highlight where the tile is placed
    if (ID!=-1 && ROW!=-100)
    {
      g.setStroke(new BasicStroke(0.05f, BasicStroke.CAP_ROUND, BasicStroke.JOIN_ROUND));
      g.setColor(Color.black);      
      int tile=curTiles[ID];
      
      for (int r2=0; r2<TileSize; r2++)
        for (int c2=0; c2<TileSize; c2++)
        {
          if (tiles[tile][r2][c2]==0) continue;
          
          int r3=r2+ROW;
          int c3=c2+COL;
          
          g.drawRect(c3,r3,1,1);
        }            
    }
    
    //highlight cleared lines
    if (clearedH.size()>0)
    {
      g.setStroke(new BasicStroke(0.05f, BasicStroke.CAP_ROUND, BasicStroke.JOIN_ROUND));
      g.setColor(Color.black);      
      for (int r : clearedH) g.drawRect(0,r,N,1);
    }
    if (clearedV.size()>0)
    {
      g.setStroke(new BasicStroke(0.05f, BasicStroke.CAP_ROUND, BasicStroke.JOIN_ROUND));
      g.setColor(Color.black);      
      for (int c : clearedV) g.drawRect(c,0,1,N);
    }        
  }
  
  private double shorten(double a)
  {
    return (double)Math.round(a * 1000.0) / 1000.0;
  }  
  
  private Image loadImage(String name)
  {
    try{
      Image im=ImageIO.read(getClass().getResourceAsStream(name));
      return im;
    } catch (Exception e) { 
      return null;  
    }             
  }   

  private void init() {
    if (hasVis())
    {
      images = new Image[Names.length];
      for (int i=0; i<Names.length; i++)
        images[i]=loadImage("images/"+Names[i]);
        
      setDefaultDelay(500);
      setContentRect(0, 0, N, N+TileSize);
      setInfoMaxDimension(15, 17);
      addInfo("Seed", seed);
      addInfo("N", N);
      addInfo("T", T);
      addInfo("C", C);
      addInfo("F", shorten(F));
      addInfo("P", shorten(P));
      addInfoBreak();  
      addInfo("Turn", 0);
      addInfo("Last clearance", "NA");
      addInfo("Max clearance", "NA");
      addInfo("Lines cleared", "NA");
      addInfo("Drops", "NA");
      addInfoBreak();  
      addInfo("Score", "NA");
      addInfo("Time", 0);
      update();
    }
  }
  
  /**
   * Starts the Topcoder Marathon controller for command-line or ECS runner use.
   *
   * @param args Marathon controller arguments, including seed and solution
   *             command settings supplied by the scoring runner.
   */
  public static void main(String[] args) {
      new MarathonController().run(args);
  }
}
