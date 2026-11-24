use tokio::{io::AsyncReadExt, net::TcpStream};

pub(crate) async fn read_request(stream: &mut TcpStream, authority: &str) -> Option<String> {
    let mut buffer = [0; 8192];
    let mut used = 0;
    while used < buffer.len() {
        let count = stream.read(&mut buffer[used..]).await.ok()?;
        if count == 0 {
            return None;
        }
        used += count;
        let mut headers = [httparse::EMPTY_HEADER; 48];
        let mut request = httparse::Request::new(&mut headers);
        if request.parse(&buffer[..used]).ok()?.is_complete() {
            let mut hosts = request
                .headers
                .iter()
                .filter(|header| header.name.eq_ignore_ascii_case("host"));
            if request.method == Some("GET")
                && hosts.next().map(|header| header.value) == Some(authority.as_bytes())
                && hosts.next().is_none()
            {
                return request.path.map(str::to_owned);
            }
            return None;
        }
    }
    None
}
