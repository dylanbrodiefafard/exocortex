use tmpl::{Engine, Error, Template, Value};

fn ctx() -> Value {
    Value::map([
        ("name", Value::from("Ada")),
        ("admin", Value::from(true)),
        ("visits", Value::from(3_i64)),
        ("ratio", Value::from(0.25)),
        (
            "user",
            Value::map([
                ("email", Value::from("ada@example.com")),
                ("nick", Value::from("  countess  ")),
            ]),
        ),
        (
            "tags",
            Value::list([Value::from("math"), Value::from("engines")]),
        ),
        ("empty", Value::list([])),
    ])
}

#[test]
fn substitutes_values() {
    let t =
        Template::new("Hello {{ name }} <{{user.email}}>, visits={{ visits }} ratio={{ ratio }}")
            .unwrap();
    assert_eq!(
        t.render(&ctx()).unwrap(),
        "Hello Ada <ada@example.com>, visits=3 ratio=0.25"
    );
}

#[test]
fn filters_chain() {
    let t =
        Template::new("{{ user.nick | trim | upper }}:{{ tags | len }}:{{ name|lower }}").unwrap();
    assert_eq!(t.render(&ctx()).unwrap(), "COUNTESS:2:ada");
}

#[test]
fn conditionals() {
    let t =
        Template::new("{% if admin %}A{% else %}U{% endif %}{% if not empty %}-none{% endif %}")
            .unwrap();
    assert_eq!(t.render(&ctx()).unwrap(), "A-none");
}

#[test]
fn loops_shadow_and_nest() {
    let src = "{% for name in tags %}[{{ name }}{% for t in tags %}.{{ t | len }}{% endfor %}]{% endfor %} {{ name }}";
    assert_eq!(
        Template::new(src).unwrap().render(&ctx()).unwrap(),
        "[math.4.7][engines.4.7] Ada"
    );
}

#[test]
fn comments_are_dropped() {
    let t = Template::new("a{# hidden {{ nope }} #}b").unwrap();
    assert_eq!(t.render(&ctx()).unwrap(), "ab");
}

#[test]
fn syntax_errors_are_reported_at_parse_time() {
    assert!(matches!(
        Template::new("ok\n{% if admin %}x"),
        Err(Error::Syntax { line: 2, .. })
    ));
    assert!(matches!(
        Template::new("{% for x of tags %}{% endfor %}"),
        Err(Error::Syntax { line: 1, .. })
    ));
    assert!(matches!(
        Template::new("a\nb\n{% endfor %}"),
        Err(Error::Syntax { line: 3, .. })
    ));
    assert!(matches!(
        Template::new("{{ a..b }}"),
        Err(Error::Syntax { .. })
    ));
}

#[test]
fn render_errors() {
    let missing = Template::new("x\n{{ user.phone }}").unwrap().render(&ctx());
    assert_eq!(
        missing,
        Err(Error::MissingValue {
            line: 2,
            path: "user.phone".to_string()
        })
    );
    assert!(matches!(
        Template::new("{{ tags }}").unwrap().render(&ctx()),
        Err(Error::Type { line: 1, .. })
    ));
    assert!(matches!(
        Template::new("{{ name | shout }}").unwrap().render(&ctx()),
        Err(Error::UnknownFilter { line: 1, .. })
    ));
}

#[test]
fn template_keeps_its_source() {
    let src = String::from("Hi {{ name }}");
    let t = Template::new(src.clone()).unwrap();
    drop(src);
    assert_eq!(t.source(), "Hi {{ name }}");
    assert_eq!(t.render(&ctx()).unwrap(), "Hi Ada");
}

#[test]
fn engine_includes() {
    let mut engine = Engine::new();
    engine
        .add_template("layout", "<h1>{{ name }}</h1>{% include \"body\" %}")
        .unwrap();
    engine
        .add_template(
            "body",
            String::from("{% for t in tags %}<li>{{ t }}</li>{% endfor %}"),
        )
        .unwrap();
    assert_eq!(
        engine.render("layout", &ctx()).unwrap(),
        "<h1>Ada</h1><li>math</li><li>engines</li>"
    );
    assert_eq!(
        engine.render("nope", &ctx()),
        Err(Error::UnknownTemplate("nope".to_string()))
    );
}

#[test]
fn engine_built_from_generated_sources() {
    let mut engine = Engine::new();
    for (i, field) in ["name", "visits", "user.email"].iter().enumerate() {
        let source = format!("{i}={{{{ {field} }}}}");
        engine.add_template(&format!("t{i}"), source).unwrap();
    }
    let mut page = String::new();
    for i in 0..3 {
        page.push_str(&format!("{{% include \"t{i}\" %}};"));
    }
    engine.add_template("page", page).unwrap();
    assert_eq!(engine.len(), 4);
    assert_eq!(
        engine.render("page", &ctx()).unwrap(),
        "0=Ada;1=3;2=ada@example.com;"
    );
}

#[test]
fn include_cycles_are_caught() {
    let mut engine = Engine::new();
    engine.add_template("a", "{% include \"b\" %}").unwrap();
    engine.add_template("b", "{% include \"a\" %}").unwrap();
    assert!(matches!(
        engine.render("a", &ctx()),
        Err(Error::IncludeDepth(_))
    ));
}

#[test]
fn failed_add_registers_nothing() {
    let mut engine = Engine::new();
    engine.add_template("x", "fine").unwrap();
    assert!(engine.add_template("x", "{% if %}").is_err());
    assert_eq!(engine.render("x", &ctx()).unwrap(), "fine");
}
