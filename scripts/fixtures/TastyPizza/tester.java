import java.awt.*;
import java.awt.geom.*;
import java.awt.image.*;
import java.util.*;
import java.io.*;
import javax.imageio.*;

import com.topcoder.marathon.*;

public class TastyPizzaTester extends MarathonVis {
    //parameter ranges
    private static final int minRadius = 5, maxRadius = 15;     //circle radius
    private static final int minSize = 5, maxSize = 25;         //rectangle size
    private static final int minShapes = 10, maxShapes = 500;     //number of shapes of each type
    private static final double minX = 0, maxX = 1;

    //Inputs
    private int C;      //number of circles
    private int R;      //number of rectangles
    private double X;
    private Circle[] Circles;     //NOTE: this also contains solution output
    private Rect[] Rectangles;    //NOTE: this also contains solution output

    //Constants     
    private static final int BaseRadius=100;
    private static final double EPS=1e-9;

    //State Control
    private double Score;
    private int circlesPlaced;
    private int rectanglesPlaced;
    private double CircleArea;
    private double RectangleArea;
    private boolean[] overlapC;
    private boolean[] overlapR;

    //Graphics
    Image BasePic;
    Image OlivePic;     //for small circles
    Image[] CirclePics;
    Image[] RectanglePics;


    protected void generate() {
        C = randomInt(minShapes, maxShapes);
        R = randomInt(minShapes, maxShapes);
        X = randomDouble(minX, maxX);

        //Special cases for seeds 1 and 2
        if (seed == 1)
        {
          C = minShapes;
          R = minShapes;
        }
        else if (seed == 2)
        {
          C = maxShapes;
          R = maxShapes;
        }

        //User defined parameters
        if (parameters.isDefined("C")) C = randomInt(parameters.getIntRange("C"), minShapes, maxShapes);
        if (parameters.isDefined("R")) R = randomInt(parameters.getIntRange("R"), minShapes, maxShapes);
        if (parameters.isDefined("X")) X = randomDouble(parameters.getDoubleRange("X"), minX, maxX);

        //generate circles
        Circles = new Circle[C];
        for (int i=0; i<C; i++)
        {
          int radius = randomInt(minRadius, maxRadius);
          Circles[i] = new Circle(radius);
        }
        
        //generate rectangles
        Rectangles = new Rect[R];
        for (int i=0; i<R; i++)
        {
          int height = randomInt(minSize, maxSize);
          int width = randomInt(minSize, maxSize);
          Rectangles[i] = new Rect(height, width);
        }      

        overlapC = new boolean[C];
        overlapR = new boolean[R];     

        if (debug) {
          System.out.println("Number of circles, C = " + C);
          System.out.println("Number of rectangles, R = " + R);
          System.out.println("X = " + X);
          System.out.println("circles:");
          for (int i=0; i<C; i++)
            System.out.println("id "+i+" radius "+Circles[i].radius);
          System.out.println("rectangles:");
          for (int i=0; i<R; i++)
            System.out.println("id "+i+" width "+Rectangles[i].width+" height "+Rectangles[i].height);
        }
    }

    protected boolean isMaximize() {
        return true;
    }

    protected double run() throws Exception {
        init();
        boolean ok = callSolution();
        if (!ok) {
            if (!isReadActive()) return getErrorScore();
            return fatalError();
        }

        boolean foundOverlap=false;

        //check that two circles don't overlap
        for (int i=0; i<C; i++)
          for (int k=i+1; k<C; k++)
            if (Circles[i].used && Circles[k].used && overlap(Circles[i],Circles[k]))
            {
              System.out.println("ERROR: Circles "+i+" and "+k+" overlap!");
              overlapC[i]=true;
              overlapC[k]=true;
              foundOverlap=true;
            }

        //check that two rectangles don't overlap
        for (int i=0; i<R; i++)
          for (int k=i+1; k<R; k++)
            if (Rectangles[i].used && Rectangles[k].used && overlap(Rectangles[i],Rectangles[k]))
            {
              System.out.println("ERROR: Rectangles "+i+" and "+k+" overlap!"); 
              overlapR[i]=true;
              overlapR[k]=true;
              foundOverlap=true;
            }

        //check that circles don't overlap with rectangles
        for (int i=0; i<C; i++)
          for (int k=0; k<R; k++)
            if (Circles[i].used && Rectangles[k].used && overlap(Circles[i],Rectangles[k]))
            {
              System.out.println("ERROR: Circle "+i+" and rectangle "+k+" overlap!");   
              overlapC[i]=true;
              overlapR[k]=true;
              foundOverlap=true;           
            }
            
        //check that circles don't go outside the base
        for (int i=0; i<C; i++)
          if (Circles[i].used)
            if (distance2(Circles[i].x,Circles[i].y,0,0) > sq(BaseRadius - Circles[i].radius))
            {
              System.out.println("ERROR: Circle "+i+" goes outside of base!");             
              overlapC[i]=true;
              foundOverlap=true;
            }
            
        //check that rectangles don't go outside the base
        for (int i=0; i<R; i++)
          if (Rectangles[i].used)
          {          
            //check all corners
            if (distance2(Rectangles[i].x,Rectangles[i].y,0,0) > sq(BaseRadius) || 
                distance2(Rectangles[i].x+Rectangles[i].width,Rectangles[i].y,0,0) > sq(BaseRadius) ||
                distance2(Rectangles[i].x,Rectangles[i].y+Rectangles[i].height,0,0) > sq(BaseRadius) ||
                distance2(Rectangles[i].x+Rectangles[i].width,Rectangles[i].y+Rectangles[i].height,0,0) > sq(BaseRadius))
            {
              System.out.println("ERROR: Rectangle "+i+" goes outside of base!");             
              overlapR[i]=true;
              foundOverlap=true;            
            }
          }
        
            
        //compute ingredients area
        CircleArea=0;
        circlesPlaced=0;
        for (int i=0; i<C; i++)
          if (Circles[i].used)
          {
            circlesPlaced++;
            CircleArea+=Math.PI*sq(Circles[i].radius);
          }

        RectangleArea=0;          
        rectanglesPlaced=0;
        for (int i=0; i<R; i++)
          if (Rectangles[i].used)
          {
            rectanglesPlaced++;
            RectangleArea+=Rectangles[i].height*Rectangles[i].width;
          }
     

        Score=CircleArea + RectangleArea - Math.abs(X*CircleArea - (1-X)*RectangleArea);
        if (foundOverlap) Score=-1;       //solution is invalid because it contains an overlap


        if (debug) {
          System.out.println("used circles: "+circlesPlaced+" / "+C);
          for (int i=0; i<C; i++)
            if (Circles[i].used)
              System.out.println("id "+i+" radius "+Circles[i].radius+" x "+Circles[i].x+" y "+Circles[i].y);
              
          System.out.println("used rectangles: "+rectanglesPlaced+" / "+R);
          for (int i=0; i<R; i++)
            if (Rectangles[i].used)
              System.out.println("id "+i+" width "+Rectangles[i].width+" height "+Rectangles[i].height+" x "+Rectangles[i].x+" y "+Rectangles[i].y);
          
          System.out.println("Circle Area "+CircleArea);
          System.out.println("Rectangle Area "+RectangleArea);
        }
 

        if (hasVis()) {
            setContentRect(-BaseRadius * 1.05, -BaseRadius*1.05, BaseRadius * 1.05, BaseRadius * 1.05);
            addInfo("Circles placed", circlesPlaced);
            addInfo("Rects placed", rectanglesPlaced);            
            addInfo("Circles area", String.format("%.4f", CircleArea));
            addInfo("Rects area", String.format("%.4f", RectangleArea));
            addInfo("Score", String.format("%.4f", Score));
            addInfo("Time", getRunTime() + " ms");
            update();
        }
        return Score;
    }

    protected int distance2(int x1, int y1, int x2, int y2)
    {
      return sq(x1-x2)+sq(y1-y2);
    }    

    protected int sq(int a)
    {
      return a*a;
    }

    protected double sq_d(double a)
    {
      return a*a;
    }    

    //circle-circle overlap
    protected boolean overlap(Circle A, Circle B)
    {
      return distance2(A.x,A.y,B.x,B.y) < sq(A.radius + B.radius);
    }

    //rectangle-rectangle overlap
    protected boolean overlap(Rect A, Rect B)
    {
      return A.x < B.x+B.width  && A.x+A.width > B.x &&
             A.y < B.y+B.height && A.y+A.height > B.y;
    }

    //circle-rectangle overlap
    //from https://stackoverflow.com/questions/401847/circle-rectangle-collision-detection-intersection
    protected boolean overlap(Circle A, Rect B)
    {
      double x = Math.abs(A.x - (B.x+B.width/2.0));
      double y = Math.abs(A.y - (B.y+B.height/2.0));
      if (x+EPS > B.width/2.0 + A.radius) return false;
      if (y+EPS > B.height/2.0 + A.radius) return false;
      if (x+EPS < B.width/2.0) return true;
      if (y+EPS < B.height/2.0) return true;
      double cornerDist = sq_d(x - B.width/2.0) + sq_d(y - B.height/2.0);
      return (cornerDist+EPS < sq(A.radius));
    }    

    protected void paintContent(Graphics2D g)
    {
      adjustFont(g, Font.SANS_SERIF, Font.PLAIN, String.valueOf(Math.max(R,C)), new Rectangle2D.Double(0, 0, BaseRadius*0.05, BaseRadius*0.05));
      g.setStroke(new BasicStroke((float)(0.005*BaseRadius), BasicStroke.CAP_ROUND, BasicStroke.JOIN_ROUND));

      //draw base
      if (parameters.isDefined("noimages"))
      {
        g.setColor(Color.orange);
        Ellipse2D base = new Ellipse2D.Double(-BaseRadius,-BaseRadius,BaseRadius*2,BaseRadius*2);
        g.fill(base);
      }
      else
      {
        g.drawImage(BasePic,rnd(-BaseRadius),rnd(-BaseRadius),rnd(BaseRadius*2),rnd(BaseRadius*2),null);
      }

      //draw circles
      for (int i=0; i<C; i++)
      {
        if (!Circles[i].used) continue;
        
        int r=Circles[i].radius;   

        if (parameters.isDefined("noimages"))
        { 
          Ellipse2D circle = new Ellipse2D.Double(Circles[i].x-r,-Circles[i].y+r-r*2,r*2,r*2);
          g.setColor(Color.green);  
          g.fill(circle);   

          if (overlapC[i]) g.setColor(Color.red);  
          else g.setColor(Color.black);  
          g.draw(circle);                  
        }
        else
        {
          Image pic=OlivePic;     //draw olive for small circles
          if (r>maxRadius*0.35)
            pic=CirclePics[(int)(Math.random()*CirclePics.length)];   
          g.drawImage(pic,rnd(Circles[i].x-r),rnd(-Circles[i].y+r-r*2),r*2,r*2,null);   //up is higher y           
        }
        
        if (parameters.isDefined("shownumbers"))
        {
          g.setColor(Color.black);    
          drawString(g, String.valueOf(i), new Rectangle2D.Double(Circles[i].x,-Circles[i].y, 0,0));        
        }
      }

      //draw rectangles
      for (int i=0; i<R; i++)
      {
        if (!Rectangles[i].used) continue;
        
        if (parameters.isDefined("noimages"))
        {
          g.setColor(Color.cyan);     
          Rectangle2D rectangle = new Rectangle2D.Double(Rectangles[i].x,-Rectangles[i].y-Rectangles[i].height,Rectangles[i].width,Rectangles[i].height);
          g.fill(rectangle);  

          if (overlapR[i]) g.setColor(Color.red);  
          else g.setColor(Color.black);  
          g.draw(rectangle);              
        }
        else
        {
          Image pic=RectanglePics[(int)(Math.random()*RectanglePics.length)];  
          g.drawImage(pic,rnd(Rectangles[i].x),rnd(-Rectangles[i].y-Rectangles[i].height),Rectangles[i].width,Rectangles[i].height,null);   //up is higher y          
        }
        
        if (parameters.isDefined("shownumbers"))
        {
          g.setColor(Color.black);    
          drawString(g, String.valueOf(i), new Rectangle2D.Double(Rectangles[i].x+Rectangles[i].width/2.0,-Rectangles[i].y-Rectangles[i].height/2.0, 0,0));                  
        }
      }      
    }

    private int rnd(double a)
    {
      return (int)Math.round(a);
    }

    private void init() {
        if (hasVis()) {
            //load pictures
            BasePic = loadImage("images/baseCropped.png");
            OlivePic = loadImage("images/oliveCropped.png");

            String[] circleNames={"salamiCrop","onionCrop","tomato"};
            CirclePics = new Image[circleNames.length];
            for (int i=0; i<circleNames.length; i++)
              CirclePics[i] = loadImage("images/"+circleNames[i]+".png");          

            String[] rectangleNames={"pineappleCrop","greenPepperCrop","redPepperCrop"};
            RectanglePics = new Image[rectangleNames.length];
            for (int i=0; i<rectangleNames.length; i++)
              RectanglePics[i] = loadImage("images/"+rectangleNames[i]+".png");                    

            setInfoMaxDimension(20, 15);
            addInfo("Seed", seed);
            addInfo("C", C);
            addInfo("R", R);
            addInfo("X", String.format("%.4f", X));
            addInfoBreak();
            addInfo("Circles placed", " - ");
            addInfo("Rects placed", " - ");
            addInfoBreak();    
            addInfo("Circles area", "-");
            addInfo("Rects area", "-");
            addInfo("Score", "-");
            addInfoBreak();
            addInfo("Time", "-");
            update();
        }
    }

    //return true if everything is good
    private boolean callSolution() throws Exception {
        writeLine(C);
        writeLine(R);
        writeLine(""+X);       
        for (int i=0; i<C; i++) writeLine(Circles[i].radius);
        for (int i=0; i<R; i++) writeLine(Rectangles[i].width+" "+Rectangles[i].height);
        flush();
        if (!isReadActive()) return false;

        startTime();
        int n = readLineToInt(-1);
        if (n != C+R) {
            setErrorMessage("Invalid number of shapes: " + getLastLineRead());
            return false;
        }
        
        //read circles
        for (int i=0; i<C; i++)
        {
          String s = readLine();
          if (s.equals("NA")) Circles[i].used=false;
          else
          {
            String[] temp = s.split(" ");
            if (temp.length!=2)
            {
              setErrorMessage("Circle "+i+" is invalid: "+s);
              return false;
            }
            
            int x;
            int y;
            try
            {
              x=Integer.parseInt(temp[0]);
              y=Integer.parseInt(temp[1]);
              if (x<-BaseRadius || x>BaseRadius || y<-BaseRadius || y>BaseRadius)
              {
                setErrorMessage("Circle "+i+" is out of bounds: "+s);
                return false;  
              }
            }
            catch (Error e)
            {
              setErrorMessage("Circle "+i+" is invalid: "+s);
              return false;          
            }
            Circles[i].used=true;
            Circles[i].x=x;
            Circles[i].y=y;
          }
        }

        //read rectangles
        for (int i=0; i<R; i++)
        {
          String s = readLine();
          if (s.equals("NA")) Rectangles[i].used=false;
          else
          {
            String[] temp = s.split(" ");
            if (temp.length!=2)
            {
              setErrorMessage("Rectangle "+i+" is invalid: "+s);
              return false;
            }
            
            int x;
            int y;
            try
            {
              x=Integer.parseInt(temp[0]);
              y=Integer.parseInt(temp[1]);
              if (x<-BaseRadius || x>BaseRadius || y<-BaseRadius || y>BaseRadius)
              {
                setErrorMessage("Rectangle "+i+" is out of bounds: "+s);
                return false;  
              }            
            }
            catch (Error e)
            {
              setErrorMessage("Rectangle "+i+" is invalid: "+s);
              return false;          
            }
            Rectangles[i].used=true;
            Rectangles[i].x=x;
            Rectangles[i].y=y;
          }
        }        
        stopTime();
        return true;
    }

    Image loadImage(String name) {
      try{
        Image im=ImageIO.read(new File(name));
        return im;
      } catch (Exception e) { 
        return null;  
      }             
    }      
    
    
    class Circle
    {
      boolean used;
      int radius;
      //center of the circle
      int x;     
      int y;

      public Circle(int r)
      {
        radius=r;
      }
    }
    
    class Rect
    {
      boolean used;
      int height;
      int width;
      //bottom-left of the rectangle
      int x;   
      int y;

      public Rect(int h, int w)
      {
        height=h;
        width=w;
      }

      public Rect(int x2, int y2, int h, int w)
      {
        x=x2;
        y=y2;
        height=h;
        width=w;
      }      
    }    
    

    public static void main(String[] args) {
        new MarathonController().run(args);
    }
}