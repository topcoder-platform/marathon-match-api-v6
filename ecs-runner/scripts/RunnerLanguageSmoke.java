import java.lang.reflect.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.nio.file.attribute.PosixFilePermissions;
import java.util.concurrent.TimeUnit;

/** Executes the real runner compiler and scorer isolation bridge for each supported language. */
public class RunnerLanguageSmoke {
    public static void main(String[] args) throws Exception {
        String[][] fixtures = {
            {".java", "public class Example { public static void main(String[] a) { System.out.println(42); } }"},
            {".cpp", "#include <iostream>\nint main(){std::cout << 42 << std::endl;}"},
            {".py", "print(42)"},
            {".kt", "fun main() { println(42) }"},
            {".rs", "fn main(){println!(\"42\");}"},
            {".cs", "using System; class Example { static void Main(){Console.WriteLine(42);} }"},
            {".cs_net7", "using System; class Example { static void Main(){Console.WriteLine(42);} }"},
            {".cs_net10", "using System; class Example { static void Main(){Console.WriteLine(42);} }"}
        };
        Class<?> runner = Class.forName("com.topcoder.runner.EcsRunnerMain");
        Method compile = runner.getDeclaredMethod("compileAndBuildExecutionCommand", Path.class,
                Path.class, int.class, String.class, Path.class);
        compile.setAccessible(true);
        for (String[] fixture : fixtures) {
            Path workspace = Files.createTempDirectory("mm-language-smoke-");
            Files.setPosixFilePermissions(workspace, PosixFilePermissions.fromString("rwxr-xr-x"));
            Path source = workspace.resolve("Example" + fixture[0]);
            Files.write(source, fixture[1].getBytes(StandardCharsets.UTF_8));
            Path log = workspace.resolve("compile.log");
            Object result;
            try {
                result = compile.invoke(null, source, workspace, 120000, "Example", log);
            } catch (InvocationTargetException error) {
                if (Files.exists(log)) System.err.println(new String(Files.readAllBytes(log), StandardCharsets.UTF_8));
                throw new RuntimeException("Compilation failed for " + fixture[0], error.getCause());
            }
            Method commandGetter = result.getClass().getDeclaredMethod("getExecutionCommand");
            commandGetter.setAccessible(true);
            String command = (String) commandGetter.invoke(result);
            Path output = workspace.resolve("stdout.log");
            Path errors = workspace.resolve("stderr.log");
            Process process = new ProcessBuilder("sh", "-c", command).directory(workspace.toFile())
                    .redirectOutput(output.toFile()).redirectError(errors.toFile()).start();
            if (!process.waitFor(30, TimeUnit.SECONDS)) {
                process.destroyForcibly();
                throw new AssertionError("Execution timeout: " + fixture[0]);
            }
            String stdout = new String(Files.readAllBytes(output), StandardCharsets.UTF_8).trim();
            if (process.exitValue() != 0 || !stdout.equals("42")) {
                throw new AssertionError(fixture[0] + " exit=" + process.exitValue() + " stdout=" + stdout
                    + " stderr=" + new String(Files.readAllBytes(errors), StandardCharsets.UTF_8));
            }
            System.out.println("PASS " + fixture[0] + " compiled and executed under scorer isolation");
        }
    }
}
