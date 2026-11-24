use crate::loopback::read_request;
use std::{net::Ipv4Addr, time::Duration};
use tokio::{
    io::AsyncWriteExt,
    net::{TcpListener, TcpStream},
    sync::OnceCell,
    time::timeout,
};

const YOUTUBE: &str = "https://www.youtube-nocookie.com";
static ENDPOINT: OnceCell<String> = OnceCell::const_new();

#[tauri::command]
pub(crate) async fn recommendation_trailer_endpoint(
    app: tauri::AppHandle,
) -> Result<String, String> {
    ENDPOINT
        .get_or_try_init(|| async {
            let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await?;
            let authority = listener.local_addr()?.to_string();
            let path = format!("/trailers/{}/", uuid::Uuid::new_v4());
            let endpoint = format!("http://{authority}{path}");
            let app_id = app.config().identifier.clone();
            tauri::async_runtime::spawn(serve(listener, authority, path, app_id));
            Ok::<_, std::io::Error>(endpoint)
        })
        .await
        .cloned()
        .map_err(|error| format!("Could not start the inline trailer player: {error}"))
}

async fn serve(listener: TcpListener, authority: String, path: String, app_id: String) {
    while let Ok((mut stream, _)) = listener.accept().await {
        let _ = timeout(
            Duration::from_secs(2),
            respond(&mut stream, &authority, &path, &app_id),
        )
        .await;
    }
}

async fn respond(
    stream: &mut TcpStream,
    authority: &str,
    path: &str,
    app_id: &str,
) -> std::io::Result<()> {
    let target = read_request(stream, authority).await;
    let html = target
        .as_deref()
        .and_then(|target| target.strip_prefix(path))
        .and_then(|id| player_page(id, app_id));
    let (status, body) = match html.as_deref() {
        Some(body) => ("200 OK", body),
        None => ("404 Not Found", ""),
    };
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\n\
         Cache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\n\
         Referrer-Policy: strict-origin-when-cross-origin\r\n\
         Content-Security-Policy: default-src 'none'; frame-src {YOUTUBE}; script-src 'unsafe-inline' https://www.youtube.com/iframe_api https://www.youtube.com/s/player/; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'\r\n\
         Connection: close\r\n\r\n{body}",
        body.len()
    );
    stream.write_all(response.as_bytes()).await
}

fn player_page(id: &str, app_id: &str) -> Option<String> {
    if id.len() != 11
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"-_".contains(&byte))
    {
        return None;
    }
    let widget_referrer: String =
        url::form_urlencoded::byte_serialize(format!("https://{app_id}").as_bytes()).collect();
    // A normal HTTP document supplies the Referer that custom WebView schemes omit.
    // YouTube stays in its own origin and renders its own controls.
    Some(format!(
        r#"<!doctype html><html lang="en"><meta charset="utf-8"><title>YouTube trailer</title>
<style>html,body,iframe{{margin:0;width:100%;height:100%;border:0;display:block;background:#000;overflow:hidden}}</style>
<iframe id="player" title="YouTube trailer" src="{YOUTUBE}/embed/{id}?autoplay=1&amp;mute=1&amp;playsinline=1&amp;enablejsapi=1&amp;widget_referrer={widget_referrer}" referrerpolicy="strict-origin-when-cross-origin" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen></iframe>
<script>
function onYouTubeIframeAPIReady() {{
  new YT.Player('player', {{events: {{
    onStateChange: (event) => {{
      if (event.data === YT.PlayerState.ENDED) parent.postMessage('nexitv:trailer-ended', '*');
    }},
    onAutoplayBlocked: () => parent.postMessage('nexitv:trailer-blocked', '*'),
    onError: () => parent.postMessage('nexitv:trailer-error', '*')
  }}}});
}}
</script><script async src="https://www.youtube.com/iframe_api"></script></html>"#
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_only_the_requested_youtube_video() {
        let page = player_page("ESEUoa-mz2c", "com.nexitv.desktop").unwrap();
        assert!(page.contains("https://www.youtube-nocookie.com/embed/ESEUoa-mz2c?"));
        assert!(page.contains("autoplay=1&amp;mute=1"));
        assert!(page.contains("widget_referrer=https%3A%2F%2Fcom.nexitv.desktop"));
        assert!(player_page("bad/path?id", "com.nexitv.desktop").is_none());
        assert!(player_page("ESEUoa-mz2c?x", "com.nexitv.desktop").is_none());
    }

    #[tokio::test]
    async fn serves_only_the_matching_host_and_private_path() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let authority = listener.local_addr().unwrap().to_string();
        let path = "/trailers/test-token/";
        let task = tokio::spawn(serve(
            listener,
            authority.clone(),
            path.into(),
            "com.nexitv.desktop".into(),
        ));
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let url = format!("http://{authority}{path}ESEUoa-mz2c");
        let response = client.get(&url).send().await.unwrap();
        assert_eq!(response.status(), 200);
        assert!(response.text().await.unwrap().contains("enablejsapi=1"));
        assert_eq!(
            client
                .get(&url)
                .header("Host", "other.test")
                .send()
                .await
                .unwrap()
                .status(),
            404
        );
        assert_eq!(
            client
                .get(format!("http://{authority}/ESEUoa-mz2c"))
                .send()
                .await
                .unwrap()
                .status(),
            404
        );
        task.abort();
    }
}
