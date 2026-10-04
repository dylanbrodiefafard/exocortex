use std::io::{self, BufRead, Write};
use std::process::ExitCode;

const USAGE: &str = "usage: rill eval EXPR | rill type EXPR | rill fmt EXPR | rill ops | rill repl";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.as_slice() {
        [cmd, src] if cmd == "eval" => report(src, rill::eval(src).map(|v| v.to_string())),
        [cmd, src] if cmd == "type" => report(src, rill::check(src).map(|t| t.to_string())),
        [cmd, src] if cmd == "fmt" => report(src, rill::format(src)),
        [cmd] if cmd == "ops" => {
            print!("{}", rill::describe_operators());
            ExitCode::SUCCESS
        }
        [cmd] if cmd == "repl" => repl(),
        _ => {
            eprintln!("{USAGE}");
            ExitCode::from(2)
        }
    }
}

fn report(src: &str, result: rill::Result<String>) -> ExitCode {
    match result {
        Ok(text) => {
            println!("{text}");
            ExitCode::SUCCESS
        }
        Err(err) => {
            eprintln!("{}", err.render(src));
            ExitCode::FAILURE
        }
    }
}

fn repl() -> ExitCode {
    let stdin = io::stdin();
    let mut out = io::stdout();
    loop {
        print!("rill> ");
        let _ = out.flush();
        let mut line = String::new();
        match stdin.lock().read_line(&mut line) {
            Ok(0) | Err(_) => return ExitCode::SUCCESS,
            Ok(_) => {}
        }
        let src = line.trim();
        if src.is_empty() {
            continue;
        }
        match rill::eval(src) {
            Ok(value) => println!("{value}"),
            Err(err) => println!("{}", err.render(src)),
        }
    }
}
