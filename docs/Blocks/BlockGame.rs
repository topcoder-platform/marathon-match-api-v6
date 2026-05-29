use std::io::{self, BufRead, Write};

const TILE_SIZE: usize = 3;

/// Reads a single trimmed line from the interactive tester input.
///
/// The caller passes the locked standard input stream. The returned string is
/// used by the Blocks sample submission to parse scalar values and tile rows
/// as the tester sends them. An `io::Error` is returned when the tester closes
/// the stream before a complete line is available.
fn read_trimmed_line(input: &mut impl BufRead) -> io::Result<String> {
    let mut line = String::new();
    let bytes_read = input.read_line(&mut line)?;

    if bytes_read == 0 {
        return Err(io::Error::new(
            io::ErrorKind::UnexpectedEof,
            "tester input ended unexpectedly",
        ));
    }

    Ok(line.trim().to_string())
}

/// Parses the next tester input line as a value of the requested type.
///
/// The `name` parameter identifies the value in parse errors. The parsed value
/// is returned for the sample submission's setup and turn updates. An
/// `io::Error` is returned if the input line cannot be read or parsed.
fn read_value<T>(input: &mut impl BufRead, name: &str) -> io::Result<T>
where
    T: std::str::FromStr,
    T::Err: std::fmt::Display,
{
    let raw = read_trimmed_line(input)?;

    raw.parse::<T>().map_err(|error| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("invalid {name} value `{raw}`: {error}"),
        )
    })
}

/// Reads one 3x3 Blocks tile from the tester.
///
/// Tiles arrive as nine digits in row-major order. The returned tile is used
/// for collision checks and local board updates. An `io::Error` is returned
/// when the tester sends a malformed tile string.
fn read_tile(input: &mut impl BufRead) -> io::Result<[[i32; TILE_SIZE]; TILE_SIZE]> {
    let raw = read_trimmed_line(input)?;
    let bytes = raw.as_bytes();

    if bytes.len() != TILE_SIZE * TILE_SIZE || bytes.iter().any(|byte| !byte.is_ascii_digit()) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("invalid tile `{raw}`"),
        ));
    }

    let mut tile = [[0; TILE_SIZE]; TILE_SIZE];

    for row in 0..TILE_SIZE {
        for col in 0..TILE_SIZE {
            tile[row][col] = i32::from(bytes[row * TILE_SIZE + col] - b'0');
        }
    }

    Ok(tile)
}

/// Runs a direct Rust port of the official simple Blocks sample submission.
///
/// The program reads the initial board and active tiles from standard input,
/// scans deterministic 3x3 placements, prints valid moves, then reads the
/// replacement tile and elapsed time after each accepted move. It returns an
/// `io::Error` only when interactive tester input or output fails.
fn main() -> io::Result<()> {
    let stdin = io::stdin();
    let mut input = stdin.lock();
    let stdout = io::stdout();
    let mut output = stdout.lock();

    let n: usize = read_value(&mut input, "grid size")?;
    let tile_count: usize = read_value(&mut input, "tile count")?;
    let _fruit_count: i32 = read_value(&mut input, "fruit count")?;
    let _grid_fill_ratio: f64 = read_value(&mut input, "grid fill ratio")?;
    let _tile_fill_ratio: f64 = read_value(&mut input, "tile fill ratio")?;

    let mut grid = vec![vec![0; n]; n];

    for row in 0..n {
        for col in 0..n {
            grid[row][col] = read_value(&mut input, "grid cell")?;
        }
    }

    let mut tiles = vec![[[0; TILE_SIZE]; TILE_SIZE]; tile_count];

    for tile in &mut tiles {
        *tile = read_tile(&mut input)?;
    }

    let placements_per_row = n / TILE_SIZE;

    for turn in 0..1000 {
        let tile_id = turn % tile_count;
        let row = ((turn / placements_per_row) * TILE_SIZE) % (n - 2);
        let col = ((turn % placements_per_row) * TILE_SIZE) % (n - 2);

        let mut valid = true;

        for tile_row in 0..TILE_SIZE {
            for tile_col in 0..TILE_SIZE {
                if tiles[tile_id][tile_row][tile_col] > 0
                    && grid[row + tile_row][col + tile_col] > 0
                {
                    valid = false;
                }
            }
        }

        if !valid {
            continue;
        }

        for tile_row in 0..TILE_SIZE {
            for tile_col in 0..TILE_SIZE {
                if tiles[tile_id][tile_row][tile_col] > 0 {
                    grid[row + tile_row][col + tile_col] = tiles[tile_id][tile_row][tile_col];
                }
            }
        }

        writeln!(output, "{tile_id} {row} {col}")?;
        output.flush()?;

        tiles[tile_id] = read_tile(&mut input)?;
        let _elapsed_time: i32 = read_value(&mut input, "elapsed time")?;
    }

    writeln!(output, "-1")?;
    output.flush()
}
