FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
      openssh-server python3 curl ca-certificates git sudo procps less \
    && rm -rf /var/lib/apt/lists/*

# Password auth + SFTP for the Claude Notify deployer.
RUN rm -f /etc/ssh/sshd_config.d/*.conf \
    && sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication yes/' /etc/ssh/sshd_config \
    && sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config \
    && sed -i 's|^#\?Subsystem[[:space:]]*sftp.*|Subsystem sftp /usr/lib/openssh/sftp-server|' /etc/ssh/sshd_config \
    && (grep -q '^AllowUsers ' /etc/ssh/sshd_config || echo 'AllowUsers claude' >> /etc/ssh/sshd_config)

ARG CLAUDE_PASSWORD=claude
RUN useradd -m -s /bin/bash claude \
    && echo "claude:${CLAUDE_PASSWORD}" | chpasswd \
    && mkdir -p /home/claude/.ssh /run/sshd \
    && chown -R claude:claude /home/claude \
    && chmod 700 /home/claude/.ssh

USER claude
RUN curl -fsSL https://claude.ai/install.sh | bash
RUN echo 'export PATH="$HOME/.local/bin:$PATH"' >> /home/claude/.bashrc \
    && echo 'export PATH="$HOME/.local/bin:$PATH"' >> /home/claude/.profile
USER root

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

EXPOSE 22
CMD ["/usr/local/bin/entrypoint.sh"]
