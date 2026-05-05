import java.awt.*;
import java.awt.geom.*;
import java.util.*;
import java.util.List;
import java.util.ArrayList;
import java.util.stream.Collectors;

import com.topcoder.marathon.*;


public class BridgeRunnersTester extends MarathonAnimatedVis {
  //parameter ranges
  private static final int minN = 25, maxN = 80;    // number of islands range
  private static final int minB = 4, maxB = 20;    // number of bridgemen
  private static final int minO = 4, maxO = 10;     // number of visible orders

  //Inputs
  private int N;            // number of islands
  private int B;            // number of bridgemen
  private int O;            // number of orders

  //Constants other
  private static final int MAX_TURNS = 1000;
  private static final int SIZE = 10000;           // grid size

  private static final int INIT_CARRY_BRIDGE_LEN = 50;
  private static final int MAX_CARRY_BRIDGE_LEN = 60;

  private int realDistToBridgeLen(double realDist) {return (int) realDist / 40;}

  // and Generation
  private static final int generationMinIslandDistance = 500;
  private static final int generationIslandEdgeMargin = 200;
  private static final int generationMaxObtuseAngle = 160;

  //Graphics
  private static final int islandVisRadius = 200;
  private static final int bridgemanVisRadius = 100;
  private static final int visDashedLen = 80;

  private static final Color colBackground = new Color(93, 173, 226);
  private static final Color colIsland = Color.green.darker();
  private static final Color colIslandIdNoorder = Color.black;
  private static final Color colIslandIdOrder = Color.red.darker();//Color.blue.darker();//Color.red.darker();
  private static final Color colBridgeman = Color.white;
  private static final Color colBridgemanIdNoorder = Color.black;
  private static final Color colBridgemanIdOrder = Color.red.darker();//Color.blue.darker();//Color.red.darker();
  private static final Color colBridgemanCarry = Color.yellow.darker();
  private static final boolean colOrderDestinationThin = false;
  private static final Color colOrderDestination = Color.red.darker();//Color.blue.darker();//Color.red.darker()
  private static final Color colBridgeShortNone = Color.gray;
  private static final Color colBridgeLongNone = Color.lightGray;
  private static final Color colBridgeShortBuilt = Color.black.darker().darker();//Color.black;//new Color(123, 63, 0);
  private static final Color colBridgeLongBuilt = Color.black;//blue.darker().darker().darker();// Color.black;//new Color(165, 42, 42);
  private static final Color colOrder = Color.blue.darker();


  //pre-computed stuff
  private Point[] islandsPositions;
  private int[][] islandsDistances;
  private int[] islandsClusters;
  private Integer[] clusters;

  //State Control
  private int[] bridgemenIslandId;
  private int[] bridgemenOrderTarget;
  private int[] bridgemenCarry;
  private ArrayList<Order> orders;
  private BridgeStatus[][] bridges;
  private boolean[] used;
  private final ArrayList<Integer> bridgemenDelivered = new ArrayList<>();
  private final ArrayList<Integer> islandsDelivered = new ArrayList<>();

  private int turn;
  private double score;

  private final MessageHandler msgHandler = new MessageHandler();

  protected void generate() {
    N = randomInt(minN, maxN);
    B = randomInt(minB, maxB);
    O = randomInt(minO, maxO);

    //Special cases
    if (seed == 1) {
      N = minN;
      B = minB;
      O = minO;
    } else if (seed == 2) {
      N = maxN;
      B = maxB;
      O = maxO;
    }

    //User defined parameters
    if (parameters.isDefined("N")) N = randomInt(parameters.getIntRange("N"), minN, maxN);
    if (parameters.isDefined("B")) B = randomInt(parameters.getIntRange("B"), minB, maxB);
    if (parameters.isDefined("O")) O = randomInt(parameters.getIntRange("O"), minO, maxO);

    used = new boolean[B];

    boolean genok = false;
    while (!genok) {
      generateIslands();
      genok = calculateIslandDistances();
    }

    generateBridgemen();
    generateOrders();

    score = 0;

    if (debug) {
      System.out.println("Islands, N = " + N);
      System.out.println("Bridgemen, B = " + B);
      System.out.println("Orders, O = " + O);
    }
  }

  protected void generateIslands() {
    islandsPositions = new Point[N];
    islandsPositions[0] = new Point(SIZE / 2, SIZE / 2); // first island in the center
    for (int i = 1; i < N; ) {
      int x = randomInt(generationIslandEdgeMargin, SIZE - 1 - generationIslandEdgeMargin);
      int y = randomInt(generationIslandEdgeMargin, SIZE - 1 - generationIslandEdgeMargin);
      Point p = new Point(x, y);
      if (!isIslandPointOK(p, i)) continue;
      islandsPositions[i] = p;
      i++;
    }
  }

  private boolean isIslandPointOK(Point p, int maxi) {
    for (int i = 0; i < maxi; i++) {
      if (distPoint2Point(p, islandsPositions[i]) < generationMinIslandDistance) return false;
      //System.out.println("Island "+i+" at "+islandsPositions[i].x+","+islandsPositions[i].y + " distance "+realDistToBridgeLen(distPoint2Point(p, islandsPositions[i])));
    }
    return obtuseAngle(p, maxi);
  }

  private boolean obtuseAngle(Point p, int maxi) {
    ArrayList<Point> list = new ArrayList<Point>();
    for (int i = 0; i < maxi; i++) {
      list.add(islandsPositions[i]);
    }
    for (int i1 = 0; i1 < list.size(); i1++) {
      for (int i2 = i1 + 1; i2 < list.size(); i2++) {
        double a = distPoint2Point(list.get(i1), list.get(i2));
        double b = distPoint2Point(list.get(i1), p);
        double c = distPoint2Point(list.get(i2), p);
        if (realDistToBridgeLen(a) > INIT_CARRY_BRIDGE_LEN || realDistToBridgeLen(b) > INIT_CARRY_BRIDGE_LEN || realDistToBridgeLen(c) > INIT_CARRY_BRIDGE_LEN)
          continue;
        double alpha = Math.toDegrees(Math.acos((b * b + c * c - a * a) / (2 * b * c)));
        double beta = Math.toDegrees(Math.acos((a * a + c * c - b * b) / (2 * a * c)));
        double gamma = Math.toDegrees(Math.acos((a * a + b * b - c * c) / (2 * a * b)));
        if (alpha > generationMaxObtuseAngle || beta > generationMaxObtuseAngle || gamma > generationMaxObtuseAngle) {
          return false;
        }
      }
    }
    return true;
  }

  protected boolean calculateIslandDistances() {
    islandsDistances = new int[N][N];
    bridges = new BridgeStatus[N][N];
    for (int i = 0; i < N; i++) {
      islandsDistances[i][i] = 0;
      bridges[i][i] = BridgeStatus.NONE;

      for (int j = i + 1; j < N; j++) {
        int dist = realDistToBridgeLen(distPoint2Point(islandsPositions[i], islandsPositions[j]));
        islandsDistances[i][j] = dist;
        islandsDistances[j][i] = dist;
        bridges[i][j] = BridgeStatus.NONE;
        bridges[j][i] = BridgeStatus.NONE;
      }
    }
    islandsClusters = new int[N];
    for (int i = 0; i < N; i++) islandsClusters[i] = -1;
    int clusterId = 0;
    for (int i = 0; i < N; i++) {
      if (islandsClusters[i] != -1) continue; // already visited
      clusterBfs(i, clusterId);
      clusterId++;
    }
    if (clusterId > B) {
      //System.out.println("Warning: too many clusters ("+clusterId+") for "+B+" bridgemen, some clusters will be empty.");
      return false;
    }

    // checking are there any > 2*MAX_CARRY outliers
    if (!accessibilityBfs(0)) return false; // not all islands are accessible

    //System.out.println("Islands clusters: "+Arrays.toString(islandsClusters));
    clusters = new Integer[clusterId];
    for (int i = 0; i < clusterId; i++) clusters[i] = i;
    int[] clusterSizes = new int[clusters.length];
    for (int cId : islandsClusters) {
      if (cId >= 0) {
        clusterSizes[cId]++;
      }
    }
    Arrays.sort(clusters, Comparator.comparingInt(cId -> -clusterSizes[cId]));
    //System.out.println("Size-sorted clusters: "+Arrays.toString(clusters));
    return true;
  }

  private void clusterBfs(int start, int clusterId) {
    Queue<Integer> queue = new LinkedList<>();
    queue.add(start);
    islandsClusters[start] = clusterId;
    while (!queue.isEmpty()) {
      int current = queue.poll();
      for (int i = 0; i < N; i++) {
        if (i != current && islandsDistances[current][i] <= INIT_CARRY_BRIDGE_LEN && islandsClusters[i] == -1) {
          islandsClusters[i] = clusterId;
          queue.add(i);
        }
      }
    }
  }

  private boolean accessibilityBfs(int start) {
    boolean[] access = new boolean[N];
    Queue<Integer> queue = new LinkedList<>();
    queue.add(start);
    access[start] = true;
    while (!queue.isEmpty()) {
      int current = queue.poll();
      for (int i = 0; i < N; i++) {
        if (i != current && access[i] == false && islandsDistances[current][i] <= 2 * INIT_CARRY_BRIDGE_LEN) {
          access[i] = true;
          queue.add(i);
        }
      }
    }
    for (int i = 0; i < N; i++) {
      if (!access[i]) {
        //System.out.println("Warning: not accessible "+start+ " <-> "+i+". Need to regenerate.");
        return false;
      }
    }
    return true;
  }

  protected void generateBridgemen() {
    bridgemenIslandId = new int[B];
    bridgemenOrderTarget = new int[B];
    bridgemenCarry = new int[B];
    int M = Math.min(B, clusters.length);
    for (int i = 0; i < M; i++) {
      ArrayList<Integer> incluster = new ArrayList<>();
      for (int j = 0; j < N; j++) {
        if (islandsClusters[j] == clusters[i]) {
          incluster.add(j);
        }
      }
      //System.out.println(incluster);
      int idx = randomInt(0, incluster.size() - 1);
      bridgemenIslandId[i] = incluster.get(idx);
      bridgemenOrderTarget[i] = -1;
      bridgemenCarry[i] = INIT_CARRY_BRIDGE_LEN;
      //System.out.println("Bridgemen "+i+" on island "+bridgemenIslandId[i]+" cluster "+clusters[i]);
    }

    for (int i = M; i < B; i++) {
      int islandId = randomInt(0, N - 1);
      bridgemenIslandId[i] = islandId;
      bridgemenOrderTarget[i] = -1;
      bridgemenCarry[i] = INIT_CARRY_BRIDGE_LEN;
      //System.out.println("Bridgemen "+i+" on island "+bridgemenIslandId[i]);
    }
  }

  protected void generateOrders() {
    orders = new ArrayList<>();
    for (int i = 0; i < B * MAX_TURNS + 11 + O; i++) {
      int fromId = randomInt(0, N - 1);
      int targetId = randomInt(0, N - 1);
      while (fromId == targetId) targetId = randomInt(0, N - 1);
      orders.add(new Order(fromId, targetId));
    }
  }

  private double callSolution() throws Exception {
    writeLine("" + N);
    writeLine("" + B);
    writeLine("" + O);
    for (int i = 0; i < N; i++) {
      StringBuilder s = new StringBuilder();
      for (int j = 0; j < N; j++) {
        s.append(islandsDistances[i][j]).append(" ");
      }
      writeLine(s.toString().trim());
    }

    flush();
    if (!isReadActive()) return -1;

    updateState();

    int firstVisFrame=1;
    if (parameters.isDefined("noanimate"))
    {
      if (parameters.getStringNull("noanimate")==null) firstVisFrame = MAX_TURNS;
      else                                             firstVisFrame = parameters.getIntValue("noanimate");
    }

    try {
      for (turn = 1; turn <= MAX_TURNS; turn++) {
        // Write the time elapsed
        writeLine("" + getRunTime());
        for (int i = 0; i < B; i++) {
          writeLine(bridgemenIslandId[i] + " " + bridgemenCarry[i] + " " + bridgemenOrderTarget[i]);
        }
        for (int i = 0; i < O; i++) {
          writeLine(orders.get(i).fromId + " " + orders.get(i).destId);
        }
        flush();

        startTime();
        String line = readLine();
        stopTime();
        //System.out.println("Turn "+turn+" input: "+line);

        String[] commands = line.split("\\|");
        String[] parts;

        bridgemenDelivered.clear();
        islandsDelivered.clear();
        handleOrders();
        for (int i = 0; i < B; i++) used[i] = false; // reset used bridgemen

        for (int i = 0; i < commands.length; i++) {
          String cmd = commands[i].trim();

          if (cmd.startsWith("UNPACK ")) {
            parts = cmd.split(" ");
            if (parts.length != 3) {
              return fatalError("Illegal command format: " + commands[i]);
            }
            int bid = Integer.parseInt(parts[1]);
            if (bid < 0 || bid >= B) {
              return fatalError("Invalid bridgemen id: " + bid + " in command: " + commands[i]);
            }
            int iid = Integer.parseInt(parts[2]);
            if (iid < 0 || iid >= N) {
              return fatalError("Invalid island id: " + iid + " in command: " + commands[i]);
            }
            //System.out.println("Make bridge "+bid+" to: "+iid);
            if (used[bid]) return fatalError("Invalid UNPACK, Bridgemen " + bid + " already used: " + commands[i]);
            if (bridges[bridgemenIslandId[bid]][iid] != BridgeStatus.NONE)
              return fatalError("Invalid UNPACK, Bridge already exists: " + commands[i]);
            if (bridgemenCarry[bid] < islandsDistances[bridgemenIslandId[bid]][iid])
              return fatalError("Invalid UNPACK, not enough material: " + commands[i]);
            bridgemenCarry[bid] -= islandsDistances[bridgemenIslandId[bid]][iid];
            bridges[bridgemenIslandId[bid]][iid] = BridgeStatus.BUILT;
            bridges[iid][bridgemenIslandId[bid]] = BridgeStatus.BUILT;
            used[bid] = true; // mark bridgemen as used
          } else if (cmd.startsWith("PACK ")) {
            parts = cmd.split(" ");
            if (parts.length != 3) {
              return fatalError("Illegal command format: " + commands[i]);
            }
            int bid = Integer.parseInt(parts[1]);
            if (bid < 0 || bid >= B) {
              return fatalError("Invalid bridgemen id: " + bid + " in command: " + commands[i]);
            }
            int iid = Integer.parseInt(parts[2]);
            if (iid < 0 || iid >= N) {
              return fatalError("Invalid island id: " + iid + " in command: " + commands[i]);
            }
            //System.out.println("Pack bridge "+bid+" to: "+iid);
            if (used[bid]) return fatalError("Invalid PACK, bridgemen " + bid + " already used: " + commands[i]);
            if (bridges[bridgemenIslandId[bid]][iid] == BridgeStatus.NONE)
              return fatalError("Invalid PACK, bridge does not exists: " + commands[i]);
            if (bridgemenCarry[bid] + islandsDistances[bridgemenIslandId[bid]][iid] > MAX_CARRY_BRIDGE_LEN)
              return fatalError("Invalid PACK, bridge too long: " + commands[i]);
            bridgemenCarry[bid] += islandsDistances[bridgemenIslandId[bid]][iid];
            bridges[bridgemenIslandId[bid]][iid] = BridgeStatus.NONE;
            bridges[iid][bridgemenIslandId[bid]] = BridgeStatus.NONE;
            used[bid] = true; // mark bridgemen as used
          } else if (cmd.startsWith("MOVE ")) {
            parts = cmd.split(" ");
            if (parts.length != 3) {
              return fatalError("Illegal command format: " + commands[i]);
            }
            int bid = Integer.parseInt(parts[1]);
            if (bid < 0 || bid >= B) {
              return fatalError("Invalid bridgemen id: " + bid + " in command: " + commands[i]);
            }
            int iid = Integer.parseInt(parts[2]);
            if (iid < 0 || iid >= N) {
              return fatalError("Invalid island id: " + iid + " in command: " + commands[i]);
            }
            //System.out.println("Traverse bridge "+bid+" to: "+iid);
            if (used[bid]) return fatalError("Invalid MOVE, bridgemen " + bid + " already used: " + commands[i]);
            if (bridges[bridgemenIslandId[bid]][iid] == BridgeStatus.NONE && bridgemenIslandId[bid] != iid)
              return fatalError("Invalid MOVE, bridge does not exist: " + commands[i]);
            bridgemenIslandId[bid] = iid;
            used[bid] = true; // mark bridgemen as used
          } else if (cmd.startsWith("TEAMUNPACK ")) {
            parts = cmd.split(" ");
            if (parts.length != 4) {
              return fatalError("Illegal command format: " + commands[i]);
            }
            int bid1 = Integer.parseInt(parts[1]);
            if (bid1 < 0 || bid1 >= B) {
              return fatalError("Invalid bridgemen id: " + bid1 + " in command: " + commands[i]);
            }
            int bid2 = Integer.parseInt(parts[2]);
            if (bid2 < 0 || bid2 >= B) {
              return fatalError("Invalid bridgemen id: " + bid2 + " in command: " + commands[i]);
            }
            int len1 = Integer.parseInt(parts[3]);
            if (len1 < 0 || len1 > bridgemenCarry[bid1] || len1 > islandsDistances[bridgemenIslandId[bid1]][bridgemenIslandId[bid2]]) {
              return fatalError("Invalid main contributor length in TEAMUNPACK: " + commands[i]);
            }
            //System.out.println("Make team bridge "+bid1+" x "+bid2);
            if (used[bid1] || used[bid2])
              return fatalError("Invalid TEAMUNPACK, bridgemen already used: " + commands[i]);
            if (bridges[bridgemenIslandId[bid1]][bridgemenIslandId[bid2]] != BridgeStatus.NONE)
              return fatalError("Invalid TEAMUNPACK, bridge already exists: " + commands[i]);
            if (len1 + bridgemenCarry[bid2] < islandsDistances[bridgemenIslandId[bid1]][bridgemenIslandId[bid2]])
              return fatalError("Invalid TEAMUNPACK, not enough material: " + commands[i]);
            //int len1 = Math.min(bridgemenCarry[bid1],  islandsDistances[bridgemenIslandId[bid1]][bridgemenIslandId[bid2]]);
            bridgemenCarry[bid1] -= len1;
            bridgemenCarry[bid2] -= islandsDistances[bridgemenIslandId[bid1]][bridgemenIslandId[bid2]] - len1;
            bridges[bridgemenIslandId[bid1]][bridgemenIslandId[bid2]] = BridgeStatus.BUILT;
            bridges[bridgemenIslandId[bid2]][bridgemenIslandId[bid1]] = BridgeStatus.BUILT;
            used[bid1] = true; // mark bridgemen as used
            used[bid2] = true; // mark bridgemen as used
          } else if (cmd.startsWith("TEAMPACK ")) {
            parts = cmd.split(" ");
            if (parts.length != 4) {
              return fatalError("Illegal command format: " + commands[i]);
            }
            int bid1 = Integer.parseInt(parts[1]);
            if (bid1 < 0 || bid1 >= B) {
              return fatalError("Invalid bridgemen id: " + bid1 + " in command: " + commands[i]);
            }
            int bid2 = Integer.parseInt(parts[2]);
            if (bid2 < 0 || bid2 >= B) {
              return fatalError("Invalid bridgemen id: " + bid2 + " in command: " + commands[i]);
            }
            int len1 = Integer.parseInt(parts[3]);
            if (len1 < 0 || len1 > MAX_CARRY_BRIDGE_LEN - bridgemenCarry[bid1] || len1 > islandsDistances[bridgemenIslandId[bid1]][bridgemenIslandId[bid2]] || len1 + MAX_CARRY_BRIDGE_LEN - bridgemenCarry[bid2] < islandsDistances[bridgemenIslandId[bid1]][bridgemenIslandId[bid2]]) {
              return fatalError("Invalid main contributor length in TEAMPACK: " + commands[i]);
            }
            //System.out.println("Pack team bridge "+bid1+" x "+bid2);
            if (used[bid1] || used[bid2]) return fatalError("Invalid TEAMPACK, bridgemen already used: " + commands[i]);
            if (bridges[bridgemenIslandId[bid1]][bridgemenIslandId[bid2]] == BridgeStatus.NONE)
              return fatalError("Invalid TEAMPACK, bridge does not exists: " + commands[i]);
            //if (2*MAX_CARRY_BRIDGE_LEN-bridgemenCarry[bid1]-bridgemenCarry[bid2] < islandsDistances[bridgemenIslandId[bid1]][bridgemenIslandId[bid2]]) return fatalError("Invalid TEAMPACK, bridge too long: " + commands[i]);
            //int len1 = Math.min(MAX_CARRY_BRIDGE_LEN-bridgemenCarry[bid1],  islandsDistances[bridgemenIslandId[bid1]][bridgemenIslandId[bid2]]);
            bridgemenCarry[bid1] += len1;
            bridgemenCarry[bid2] += islandsDistances[bridgemenIslandId[bid1]][bridgemenIslandId[bid2]] - len1;
            bridges[bridgemenIslandId[bid1]][bridgemenIslandId[bid2]] = BridgeStatus.NONE;
            bridges[bridgemenIslandId[bid2]][bridgemenIslandId[bid1]] = BridgeStatus.NONE;
            used[bid1] = true; // mark bridgemen as used
            used[bid2] = true; // mark bridgemen as used
          } else if (cmd.startsWith("MSG")) {
            parts = cmd.split(" ", 2);
            msgHandler.update(parts, 1);
          } else if (cmd.length() > 0) {
            return fatalError("Unrecognizable command: '" + cmd + "'");
          }

          handleOrders();
        }

        if (debug) {
          System.out.println("Turn: " + turn);
          System.out.println("Score: " + score);
          System.out.println("Bridgemen positions: " + Arrays.stream(bridgemenIslandId).mapToObj(String::valueOf).collect(Collectors.joining(" ")));
          System.out.println("Bridgemen order targets: " + Arrays.stream(bridgemenOrderTarget).mapToObj(String::valueOf).collect(Collectors.joining(" ")));
          System.out.println("Bridgemen carry: " + Arrays.stream(bridgemenCarry).mapToObj(String::valueOf).collect(Collectors.joining(" ")));
          System.out.println();
        }

        if (turn >= firstVisFrame) updateState();
      }
    } catch (Exception e) {
      if (debug) System.out.println(e.toString());
      return fatalError("Cannot parse your output");
    }

    return score;
  }

  private void handleOrders() {
    // returning messages
    for (int bid = 0; bid < B; bid++) {
      if (bridgemenOrderTarget[bid] != bridgemenIslandId[bid]) continue;
      //System.out.println("Bridgemen "+bid+" delivered message to "+bridgemenIslandId[bid]);
      islandsDelivered.add(bridgemenIslandId[bid]);
      bridgemenOrderTarget[bid] = -1;
      score++;
      bridgemenDelivered.add(bid);
    }
    // taking messages
    while (handleTakingOrders()) {
    }
  }

  private boolean handleTakingOrders() {
    for (int oid = 0; oid < O; oid++) {
      for (int bid = 0; bid < B; bid++) {
        if (bridgemenOrderTarget[bid] != -1) continue; // already has an order
        if (bridgemenIslandId[bid] != orders.get(oid).fromId) continue; // not on the right island
        bridgemenOrderTarget[bid] = orders.get(oid).destId;
        //System.out.println("Bridgemen "+bid+" takes order "+oid+" to "+orders.get(oid).destId);
        orders.remove(oid); // remove order
        return true;
      }
    }
    return false;
  }


/////////////////////////////////


  protected void paintContent(Graphics2D g) {
    Stroke dashed = new BasicStroke(20f, BasicStroke.CAP_BUTT, BasicStroke.JOIN_BEVEL, 0, new float[]{visDashedLen}, 0);
    Stroke dashed2 = new BasicStroke(20f, BasicStroke.CAP_BUTT, BasicStroke.JOIN_BEVEL, 0, new float[]{visDashedLen}, visDashedLen);
    Stroke normal = new BasicStroke(20f, BasicStroke.CAP_ROUND, BasicStroke.JOIN_ROUND);
    Stroke thin = new BasicStroke(10f, BasicStroke.CAP_ROUND, BasicStroke.JOIN_ROUND);
    Stroke dashedthin = new BasicStroke(10f, BasicStroke.CAP_BUTT, BasicStroke.JOIN_BEVEL, 0, new float[]{visDashedLen}, 0);
    Stroke thick = new BasicStroke(30f, BasicStroke.CAP_ROUND, BasicStroke.JOIN_ROUND);

    g.setColor(colBackground);
    g.fillRect(0, 0, SIZE, SIZE);
    g.setStroke(normal);
    g.setColor(Color.black);
    g.drawRect(0, 0, SIZE, SIZE);

    if (parameters.isDefined("showPotentialBridges")) {
      for (int i = 0; i < N; i++) {
        for (int j = i + 1; j < N; j++) {
          if (islandsDistances[i][j] > 2 * MAX_CARRY_BRIDGE_LEN || bridges[i][j] == BridgeStatus.BUILT) continue;
          boolean shortb = islandsDistances[i][j] <= MAX_CARRY_BRIDGE_LEN;
          g.setStroke(shortb ? normal : thin);
          paintLine(g, islandsPositions[i], islandsPositions[j], shortb ? colBridgeShortNone : colBridgeLongNone);
        }
      }
    }

    if (parameters.isDefined("showOrders")) {
      for (int i = 0; i < N; i++) {
        for (int oid=0; oid < O; oid++) {
          if (orders.get(oid).fromId == i) {
            g.setStroke(dashedthin);
            paintLine(g, islandsPositions[i], islandsPositions[orders.get(oid).destId], colOrder);
            g.setStroke(normal);
          }
        }
      }
    }

    for (int i=0; i< N; i++) {
      for (int j=i+1; j< N; j++) {
        if (islandsDistances[i][j] > 2*MAX_CARRY_BRIDGE_LEN || bridges[i][j] == BridgeStatus.NONE) continue;
          boolean shortb = islandsDistances[i][j] <= MAX_CARRY_BRIDGE_LEN;
          g.setStroke(shortb?thick:thick);
          paintLine(g, islandsPositions[i], islandsPositions[j], shortb?colBridgeShortBuilt:colBridgeLongBuilt);
      }
    }

    g.setStroke(normal);
    adjustFont(g, Font.SANS_SERIF, Font.BOLD, String.valueOf("00"), new Rectangle2D.Double(0, 0, islandVisRadius, islandVisRadius));
    for (int i = 0; i< N; i++)
    {
      g.setColor(new Color(25, 255, 0));
      int marg=60;
      if (islandsDelivered.contains(i))
        //g.fillRect(islandsPositions[i].x - islandVisRadius-marg, islandsPositions[i].y - islandVisRadius-marg, 2*(islandVisRadius+marg), 2*(islandVisRadius+marg));
        g.fillOval (islandsPositions[i].x - islandVisRadius-marg, islandsPositions[i].y - islandVisRadius-marg, 2*(islandVisRadius+marg), 2*(islandVisRadius+marg));

      Color tcolor = colIslandIdNoorder;
      for (int oid=0; oid < O; oid++) {if (orders.get(oid).fromId == i) {tcolor = colIslandIdOrder;break;}}
      paintPointCircle(g, islandsPositions[i], islandVisRadius, colIsland, Color.black, ""+i, tcolor);
    }

    adjustFont(g, Font.SANS_SERIF, Font.BOLD, String.valueOf("00"), new Rectangle2D.Double(0, 0, 2* bridgemanVisRadius-30, 2* bridgemanVisRadius-30));
    for (int n = 0; n< N; n++) {
      ArrayList<Integer> bridgemenOnIsland = new ArrayList<>();
      for (int i = 0; i< B; i++) if (bridgemenIslandId[i] == n) bridgemenOnIsland.add(i);
      for (int j=0; j< bridgemenOnIsland.size(); j++)
      {
        double angleRad = Math.toRadians(-90+360.0 * j / bridgemenOnIsland.size());
        Point p = new Point(islandsPositions[n].x + (int)(islandVisRadius * Math.cos(angleRad)), islandsPositions[n].y + (int)(islandVisRadius * Math.sin(angleRad)));

        int i = bridgemenOnIsland.get(j);
        if (!parameters.isDefined("hideDestination") && bridgemenOrderTarget[i] != -1) {
          g.setStroke(colOrderDestinationThin?dashedthin:dashed);
          paintLine(g, p, islandsPositions[bridgemenOrderTarget[i]], colOrderDestination);
          g.setStroke(normal);
        }
        Color tcolor = colBridgemanIdNoorder;
        if (bridgemenOrderTarget[i] != -1)  tcolor = i==4?colBridgemanIdOrder.brighter():colBridgemanIdOrder;
//        g.setColor(new Color(255, 144, 0));
//        int marg=30;
//        if (bridgemenDelivered.contains(i))
//          //g.fillRect(p.x - bridgemanVisRadius-marg, p.y - bridgemanVisRadius-marg, 2*(bridgemanVisRadius+marg), 2*(bridgemanVisRadius+marg));
//          g.fillOval (p.x - bridgemanVisRadius-marg, p.y - bridgemanVisRadius-marg, 2*(bridgemanVisRadius+marg), 2*(bridgemanVisRadius+marg));
        paintPointCircle(g, p, bridgemanVisRadius, colBridgeman, Color.black, ""+i, tcolor, bridgemenCarry[i] / (double) MAX_CARRY_BRIDGE_LEN, colBridgemanCarry);
      }
    }

  }

  //region <PAINT METHODS>

  private void paintPointCircle(Graphics2D g, Point p, int radius, Color fillcol, Color bordercol, String text, Color textcol)
  {
    g.setColor(fillcol);
    g.fillOval(p.x-radius, p.y-radius, 2*radius, 2*radius);
    g.setColor(bordercol);
    g.drawOval(p.x-radius, p.y-radius, 2*radius, 2*radius);
    g.setColor(textcol);
    drawString(g, text, new Rectangle2D.Double(p.x, p.y, 0, 0));
  }

  private void paintPointCircle(Graphics2D g, Point p, int radius, Color fillcol, Color bordercol, String text, Color textcol, double fill2frac, Color fill2col)
  {
    g.setColor(fillcol);
    g.fillOval(p.x-radius, p.y-radius, 2*radius, 2*radius);
    Area circa = new Area(new Ellipse2D.Double(p.x-radius, p.y-radius, 2*radius, 2*radius));
    Area recta = new Area(new Rectangle2D.Double(p.x-radius, p.y-radius, 2*radius, 2*radius * (1-fill2frac)));
    circa.subtract(recta);
    g.setColor(fill2col);
    g.fill(circa);
    g.setColor(bordercol);
    g.drawOval(p.x-radius, p.y-radius, 2*radius, 2*radius);
    g.setColor(textcol);
    drawString(g, text, new Rectangle2D.Double(p.x, p.y, 0, 0));
  }

  private void paintLine(Graphics2D g, Point p1, Point p2, Color color)
  {
    g.setColor(color);
    g.drawLine(p1.x, p1.y, p2.x, p2.y);
  }


  // endregion

  //region <MATH METHODS>

  private double shorten(double a)
  {
    return (double)Math.round(a * 1000.0) / 1000.0;
  }


  //endregion

  //region <GEOMETRY METHODS>

  private double distPoint2Point(Point p1, Point p2)
  {
    return Math.sqrt(sq(p1.x-p2.x) + sq(p1.y-p2.y));
  }


  private int sq(int a)
  {
    return a*a;
  }
  //endregion

  //region <INFO PANEL>

  private void ordersInfo() {
    for (int i=0; i<O; i++) {addInfo("$Ord"+i, orders.get(i).niceStr());}
  }

  private void init()
  {
    if (hasVis())
    {
      setDefaultDelay(1000);    //this needs to be first

      setContentRect(0, 0, SIZE, SIZE);
      setInfoMaxDimension(5, 25);

      addInfo("Seed", seed);
      addInfo("N", N);
      addInfo("B", B);
      addInfo("O", O);
      addInfoBreak();
      addInfo("Time", "-");
      addInfo("Turns", "-");
      addInfo("Score", "-");
      addInfoBreak();
      addInfo("Orders", null);
      ordersInfo();
      addInfoBreak();
      msgHandler.addToInfo();
      update();
    }
  }

  protected void updateState()
  {
    if (hasVis())
    {
      synchronized (updateLock) {
        addInfo("Time", getRunTime());
        addInfo("Turns", turn);
        addInfo("Score", shorten(score));
        ordersInfo();
        msgHandler.addToInfo();
      }
      updateDelay();
    }
  }

  //endregion

  class Point
  {
    int x;
    int y;

    public Point(int x2, int y2)
    {
      x=x2;
      y=y2;
    }

    public String niceStr() {
      return "("+x+","+y+")";
    }
  }

  class Order
  {
    int fromId;
    int destId;

    public Order(int from, int dest)
    {
        fromId = from;
        destId = dest;
    }

    public String niceStr() {return fromId+" → "+destId;}
  }

  enum BridgeStatus {
    NONE,
    BUILT,
    // CANT,
  }

  class MessageHandler {
    public String[] lines;
    private int maxLines=0;

    public MessageHandler() {
      lines=new String[0];
      maxLines=0;
    }

    public void update(String[] command, int msgIndex) {
      if (command.length<msgIndex+1) lines=new String[0];
      else lines=command[msgIndex].trim().replace("\\n", "\n").split("\n");
      maxLines=Math.max(maxLines, lines.length);
    }

    public void addToInfo() {
      addInfo("Message", null);
      for (int i=0; i<maxLines; i++) {addInfo("$"+i, i<lines.length?lines[i]:"");}
    }
  }

  //region <DEFAULT STUFF>

  protected boolean isMaximize() {
    return true;
  }

  protected double run() throws Exception
  {
    init();

//    if (parameters.isDefined("manual"))
//    {
//      setDefaultDelay(0);
//      updateState();
//      return 0;
//    } else
    return runAuto();
  }

  protected double runAuto() throws Exception
  {
    double score = callSolution();
    if (score < 0) {
      if (!isReadActive()) return getErrorScore();
      return fatalError();
    }
    return score;
  }

  protected void timeout() {
    addInfo("Time", getRunTime());
    update();
  }

  public static void main(String[] args) {
      new MarathonController().run(args);
  }
  //endregion

}
