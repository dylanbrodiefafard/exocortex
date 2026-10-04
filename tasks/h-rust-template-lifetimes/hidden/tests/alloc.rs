use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;
use std::fmt::Write;

use tmpl::{Engine, Template, Value};

struct Counting;

thread_local! {
    static ALLOCS: Cell<usize> = const { Cell::new(0) };
    static LIVE: Cell<isize> = const { Cell::new(0) };
}

fn bump(count: usize, bytes: isize) {
    let _ = ALLOCS.try_with(|c| c.set(c.get() + count));
    let _ = LIVE.try_with(|c| c.set(c.get() + bytes));
}

unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        bump(1, layout.size() as isize);
        System.alloc(layout)
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        bump(0, -(layout.size() as isize));
        System.dealloc(ptr, layout)
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        bump(1, new_size as isize - layout.size() as isize);
        System.realloc(ptr, layout, new_size)
    }
}

#[global_allocator]
static GLOBAL: Counting = Counting;

fn allocs() -> usize {
    ALLOCS.with(|c| c.get())
}

fn live() -> isize {
    LIVE.with(|c| c.get())
}

#[test]
fn parsing_is_zero_copy_and_templates_free_their_memory() {
    let ctx = Value::map([
        ("name", Value::from("Ada")),
        ("tags", Value::list([Value::from("x"), Value::from("y")])),
    ]);
    let live0 = live();

    let mut src = String::new();
    for i in 0..2000 {
        writeln!(src, "item {i}: {{{{ name }}}}!").unwrap();
    }
    src.push_str("{% for t in tags %}{% if t %}{{ t }},{% endif %}{% endfor %}");
    let before = allocs();
    let template = Template::new(src).unwrap();
    let made = allocs() - before;
    assert!(
        made < 200,
        "parsing a template with ~4000 text/variable nodes made {made} allocations: \
         parsing must not copy pieces of the source into new strings"
    );
    let out = template.render(&ctx).unwrap();
    assert!(out.starts_with("item 0: Ada!\nitem 1: Ada!\n"));
    assert!(out.ends_with("item 1999: Ada!\nx,y,"));
    drop(out);
    drop(template);
    assert_eq!(live(), live0, "a dropped Template must free everything it allocated");

    {
        let mut engine = Engine::new();
        for i in 0..50 {
            engine
                .add_template(&format!("t{i}"), format!("{i}:{{{{ name }}}}{{% include \"t{}\" %}}", i + 1))
                .unwrap();
        }
        engine.add_template("t50", String::from("end")).unwrap();
        assert!(engine.render("t40", &ctx).unwrap().starts_with("40:Ada41:Ada"));
    }
    assert_eq!(live(), live0, "a dropped Engine must free everything it allocated");
}
