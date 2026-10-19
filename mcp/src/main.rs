use std::time::Duration;

use alsxaplus_mcp::{app::build_router, config::Config, service::Service};
use anyhow::Context;
use sqlx::postgres::PgPoolOptions;
use tracing::{error, info};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // `alsxaplus-mcp healthcheck` asks the running server whether it is well. The container has no curl.
    if std::env::args().nth(1).as_deref() == Some("healthcheck") {
        return healthcheck().await;
    }
    if let Err(err) = dotenvy::dotenv() {
        // A missing .env is normal in deployment, where variables come from the environment.
        eprintln!("no .env file loaded: {err}");
    }
    tracing_subscriber::fmt().with_env_filter(tracing_subscriber::EnvFilter::from_default_env()).init();

    let cfg = Config::from_env()?;
    let pool = PgPoolOptions::new().max_connections(8).acquire_timeout(Duration::from_secs(10)).connect(&cfg.database_url).await.context("could not connect to PostgreSQL")?;
    sqlx::migrate!("./migrations").run(&pool).await.context("database migration failed")?;
    info!("migrations applied");
    match &cfg.bedrock {
        Some(b) => info!(model = %b.model_id, region = %b.region, monthly_limit_usd = b.monthly_limit_usd, "Amazon Bedrock is on"),
        None => info!("AWS_BEARER_TOKEN_BEDROCK is not set: the rules order the sentences alone"),
    }

    let service = Service::new(pool, cfg.bedrock.clone())?;
    let sweeper = service.clone();
    let ttl = cfg.profile_ttl_hours;
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(15 * 60));
        loop {
            tick.tick().await;
            match sweeper.sweep_idle_profiles(ttl).await {
                Ok(0) => {}
                Ok(n) => info!(deleted = n, "idle profiles deleted"),
                Err(err) => error!(%err, "could not delete idle profiles"),
            }
        }
    });

    let app = build_router(service, cfg.service_key.clone(), cfg.allowed_hosts.clone());
    let listener = tokio::net::TcpListener::bind(cfg.bind_addr).await.with_context(|| format!("could not bind {}", cfg.bind_addr))?;
    info!(bind_addr = %cfg.bind_addr, allowed_hosts = ?cfg.allowed_hosts, "listening");
    axum::serve(listener, app).with_graceful_shutdown(shutdown_signal()).await.context("server stopped with an error")?;
    Ok(())
}

async fn healthcheck() -> anyhow::Result<()> {
    let port = std::env::var("PORT").unwrap_or_else(|_| "8081".to_string());
    let response = reqwest::get(format!("http://127.0.0.1:{port}/health")).await.context("the server did not answer")?;
    anyhow::ensure!(response.status().is_success(), "the server answered HTTP {}", response.status());
    Ok(())
}

/// Ctrl+C on a laptop, SIGTERM from Docker: both stop the server after open requests finish.
async fn shutdown_signal() {
    let ctrl_c = async {
        if let Err(err) = tokio::signal::ctrl_c().await {
            error!(%err, "could not listen for Ctrl+C");
            std::future::pending::<()>().await;
        }
    };
    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut stream) => {
                stream.recv().await;
            }
            Err(err) => {
                error!(%err, "could not listen for SIGTERM");
                std::future::pending::<()>().await;
            }
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {
        () = ctrl_c => info!("Ctrl+C received, shutting down"),
        () = terminate => info!("SIGTERM received, shutting down"),
    }
}
